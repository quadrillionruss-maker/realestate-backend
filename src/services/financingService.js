// financingService.js — bank financing integration, SECTION 9.
//
// This never talks to a bank's API — there isn't one to talk to. A buyer
// applies from the portal using their Archta payment history as proof of
// creditworthiness; status tracks what the OWNER does with it by hand
// (submits to the bank, hears back), moved forward only by a human PATCH,
// never automatically.
const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../middleware/orgContext');
const { renderHtmlToPdf } = require('./pdfAdapter');
const { escapeHtml } = require('../utils/escapeHtml');
const { resolveBranding } = require('./brandingService');
const { fillPlaceholders } = require('./documentService');
const { uploadPdf } = require('./documentStorage');
const { paymentHistory } = require('./legalCaseService');
const creditScore = require('./creditScoreService');
const { audit, auditSystem } = require('./auditService');
const notify = require('./notificationService');

const TEMPLATE_PATH = path.join(__dirname, '../templates/financing_letter.html');
const STATUSES = ['pending', 'submitted', 'under_review', 'approved', 'rejected', 'disbursed'];
const MIN_PROGRESS_PERCENT = 30;
const MIN_CREDIT_SCORE = 40;

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};
const formatDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// Whether a buyer's OWN "Apply for bank financing" button shows at all —
// >=30% of their total contracted value paid, and a credit score above 40.
// Read here rather than duplicated in portalService, so the one number this
// product calls "financing-eligible" is decided in exactly one place.
function isEligible({ totalContracted, totalPaid, creditScoreValue }) {
  const progressPercent = totalContracted > 0 ? (totalPaid / totalContracted) * 100 : 0;
  return progressPercent >= MIN_PROGRESS_PERCENT && Number(creditScoreValue) > MIN_CREDIT_SCORE;
}

// "Their total" (CLAUDE.md-style spec wording) reads as the buyer's WHOLE
// account, not one reservation — a buyer with two units who has paid 60% of
// one and 5% of the other has still paid a meaningful share overall. Sums
// legalCaseService.paymentHistory across every live reservation rather than
// re-deriving the same contracted/paid math a third time.
async function accountTotals(orgId, customerId) {
  const { data: reservations } = await supabaseAdmin
    .from('re_reservations')
    .select('id')
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .neq('status', 'cancelled');

  let totalContracted = 0;
  let totalPaid = 0;
  for (const reservation of reservations || []) {
    const history = await paymentHistory(orgId, reservation.id);
    if (!history) continue;
    totalContracted += history.totalContracted;
    totalPaid += history.totalPaid;
  }
  return { totalContracted, totalPaid };
}

async function orgOwnerUserId(orgId) {
  const { data: team } = await supabaseAdmin.from('teams').select('owner_id').eq('id', orgId).maybeSingle();
  // A solo workspace has no teams row at all — organization_id IS the
  // owner's own user id (CLAUDE.md's "organization_id = user.team_id ??
  // user.id").
  return team?.owner_id || orgId;
}

async function generateFinancingLetter(orgId, reservationId) {
  const history = await paymentHistory(orgId, reservationId);
  if (!history) throw Object.assign(new Error('Reservation not found'), { statusCode: 404 });

  const branding = await resolveBranding(orgId);
  const { reservation } = history;
  const customer = reservation.re_customers || {};
  const unit = reservation.re_units || {};
  const project = unit.re_projects || {};

  const { score, breakdown } = await creditScore.computeBreakdown(orgId, customer.id || reservation.customer_id);
  const consistency = breakdown.payment_consistency;
  const consistencyRate = consistency.total_due
    ? Math.round((consistency.on_time / consistency.total_due) * 100)
    : 100;

  const companyName = branding.brand_company_name || branding.company_name || branding.full_name || 'Our Company';
  const logoUrl = branding.brand_logo_url || branding.logo_url;
  const logoBlock = (logoUrl && String(logoUrl).startsWith('https://'))
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(companyName)}">`
    : '';

  return {
    html: fillPlaceholders(
      fs.readFileSync(TEMPLATE_PATH, 'utf8'),
      {
        COMPANY_NAME: companyName,
        LOGO_BLOCK: logoBlock,
        REFERENCE_NUMBER: `FIN-${reservation.id.slice(0, 8).toUpperCase()}-${Date.now()}`,
        DATE: formatDate(new Date()),
        BANK_NAME: '(named by the buyer on their application)',
        CUSTOMER_NAME: customer.full_name || 'Valued Customer',
        PROJECT_LINE: [project.name, project.location].filter(Boolean).join(', '),
        UNIT_NUMBER: unit.unit_number || '—',
        TOTAL_CONTRACTED: naira(history.totalContracted),
        TOTAL_PAID: naira(history.totalPaid),
        OUTSTANDING_BALANCE: naira(history.outstanding),
        CONSISTENCY_RATE: `${consistencyRate}%`,
        CREDIT_SCORE: `${score} / 100`,
        AMOUNT_REQUESTED: '(see accompanying application)',
      },
      ['LOGO_BLOCK']
    ),
    score,
    consistencyRate,
    history,
  };
}

async function storeFinancingLetter(orgId, reservationId) {
  const { html } = await generateFinancingLetter(orgId, reservationId);
  const pdf = await renderHtmlToPdf(html);
  const storagePath = `${orgId}/${reservationId}/financing_letter-${Date.now()}.pdf`;
  await uploadPdf(storagePath, pdf);

  const { data, error } = await supabaseAdmin
    .from('re_documents')
    .insert({
      organization_id: orgId,
      reservation_id: reservationId,
      doc_type: 'financing_letter',
      status: 'generated',
      storage_path: storagePath,
      generated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Portal: submit a request ────────────────────────────────────────────
async function requestFinancing(customer, reservationId, { bankName, amountRequested, notes }) {
  const trimmedBank = String(bankName || '').trim();
  if (!trimmedBank) throw Object.assign(new Error('bank_name is required'), { statusCode: 400 });
  const amount = Number(amountRequested);
  if (!(amount > 0)) throw Object.assign(new Error('amount_requested must be a positive amount'), { statusCode: 400 });

  const history = await paymentHistory(customer.organization_id, reservationId);
  if (!history) throw Object.assign(new Error('Reservation not found'), { statusCode: 404 });

  const { score } = await creditScore.computeBreakdown(customer.organization_id, customer.id);
  const totals = await accountTotals(customer.organization_id, customer.id);
  if (!isEligible({ totalContracted: totals.totalContracted, totalPaid: totals.totalPaid, creditScoreValue: score })) {
    throw Object.assign(
      new Error('This reservation does not yet qualify for bank financing (30% paid and a credit score above 40 are required).'),
      { statusCode: 400 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from('re_financing_requests')
    .insert({
      organization_id: customer.organization_id,
      customer_id: customer.id,
      reservation_id: reservationId,
      bank_name: trimmedBank,
      amount_requested: amount,
      notes: notes || null,
    })
    .select()
    .single();
  if (error) throw error;

  let financingLetter = null;
  try {
    financingLetter = await storeFinancingLetter(customer.organization_id, reservationId);
  } catch (err) {
    console.warn('[financing] could not generate financing letter:', err.message);
  }

  auditSystem({
    orgId: customer.organization_id,
    actorKind: 'portal',
    actorEmail: customer.email,
    action: 'financing.requested',
    entityType: 're_financing_requests',
    entityId: data.id,
    summary: `${customer.full_name} applied for ${naira(amount)} financing with ${trimmedBank}`,
    metadata: { reservation_id: reservationId, bank_name: trimmedBank, amount_requested: amount },
  });

  // The owner reviews every request before anything reaches a bank — a task
  // is how they find out, the same pattern messageService.sendFromBuyer
  // already uses for "a buyer did something, someone has to act on it".
  try {
    const ownerId = await orgOwnerUserId(customer.organization_id);
    await supabaseAdmin.from('re_tasks').insert({
      organization_id: customer.organization_id,
      title: `Review financing request — ${customer.full_name} (${trimmedBank})`,
      notes: `${naira(amount)} requested. Financing Support Letter has been generated.`,
      assigned_to: ownerId,
      related_reservation_id: reservationId,
      source: 'ai',
    });
  } catch (err) {
    console.warn('[financing] could not file review task:', err.message);
  }

  return { ...data, financing_letter: financingLetter };
}

// ── Staff ──────────────────────────────────────────────────────────────
async function listRequests(orgId, status = null) {
  let query = supabaseAdmin
    .from('re_financing_requests')
    .select(`
      *, re_customers(id, full_name, phone, email),
      re_reservations(id, re_units(unit_number, re_projects(name)))
    `)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function updateRequest(req, id, { status, bankReference, notes }) {
  const patch = {};
  if (status !== undefined) {
    if (!STATUSES.includes(status)) {
      throw Object.assign(new Error(`status must be one of: ${STATUSES.join(', ')}`), { statusCode: 400 });
    }
    patch.status = status;
    if (status === 'submitted') patch.submitted_at = new Date().toISOString();
  }
  if (bankReference !== undefined) patch.bank_reference = bankReference || null;
  if (notes !== undefined) patch.notes = notes || null;

  if (!Object.keys(patch).length) {
    throw Object.assign(new Error('No updatable fields provided'), { statusCode: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('re_financing_requests')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', req.orgId)
    .select('*, re_customers(id, full_name, phone, email)')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { notFound: true };

  audit(req, {
    action: 'financing.updated',
    entityType: 're_financing_requests',
    entityId: data.id,
    summary: `Financing request for ${data.re_customers?.full_name || 'buyer'} moved to ${patch.status || data.status}`,
    metadata: patch,
  });

  if (patch.status === 'approved') {
    const customer = data.re_customers;
    if (customer?.phone) {
      await notify.sendWhatsApp({
        orgId: req.orgId,
        to: customer.phone,
        body: `Good news, ${customer.full_name} — your bank financing request with ${data.bank_name} has been approved. `
          + 'Our office will be in touch with next steps.',
        template: 'financing_approved',
        relatedType: 're_customers',
        relatedId: customer.id,
      });
    }
  }

  return data;
}

module.exports = {
  STATUSES, MIN_PROGRESS_PERCENT, MIN_CREDIT_SCORE, isEligible,
  requestFinancing, listRequests, updateRequest, generateFinancingLetter, storeFinancingLetter,
  orgOwnerUserId, accountTotals,
};
