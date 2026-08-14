// legalCaseService.js — Legal and Recovery, SECTION 8.
//
// A case is a human decision (POST /legal-cases, owner only), never
// automatic — a reservation reaching escalation_stage 'legal'
// (escalationService.js) only ever SURFACES the "Open legal case" button,
// the same way every other AI/rule-driven recommendation in this product
// proposes and a human acts (CLAUDE.md's "Every AI output is a proposal").
const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../middleware/orgContext');
const { renderHtmlToPdf } = require('./pdfAdapter');
const { escapeHtml } = require('../utils/escapeHtml');
const { resolveBranding } = require('./brandingService');
const { fillPlaceholders } = require('./documentService');
const { uploadPdf } = require('./documentStorage');
const { contractValue } = require('./restructureService');
const { audit, auditSystem } = require('./auditService');
const notify = require('./notificationService');

const TEMPLATE_PATH = path.join(__dirname, '../templates/demand_letter.html');
const STATUSES = ['active', 'settled', 'judgment_obtained', 'withdrawn', 'closed'];

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};
const formatDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

// What the demand letter's own figures are built from — the identical shape
// portalService.loadPortalAccount and the buyer portal already compute a
// buyer's contracted/paid/outstanding totals from, so a demand letter and a
// buyer's own portal never disagree about what they owe.
async function paymentHistory(orgId, reservationId) {
  const { data: reservation, error } = await supabaseAdmin
    .from('re_reservations')
    .select(`
      id, reserved_at,
      re_customers(full_name, email, phone),
      re_units(unit_number, re_projects(name, location)),
      re_installment_plans(
        id, status, total_amount, original_total_amount,
        re_installment_schedule(id, status, amount_due)
      )`)
    .eq('id', reservationId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw error;
  if (!reservation) return null;

  let totalContracted = 0;
  let totalPaid = 0;
  let missedInstallments = 0;
  const scheduleIds = [];

  for (const plan of asArray(reservation.re_installment_plans)) {
    if (plan.status !== 'superseded') totalContracted += contractValue(plan);
    for (const row of plan.re_installment_schedule || []) {
      scheduleIds.push(row.id);
      if (row.status === 'overdue') missedInstallments += 1;
    }
  }

  const { data: payments } = scheduleIds.length
    ? await supabaseAdmin
        .from('re_payments')
        .select('amount, reallocated_from_payment_id')
        .in('schedule_id', scheduleIds)
        .is('voided_at', null)
    : { data: [] };
  totalPaid = (payments || [])
    .filter((p) => !p.reallocated_from_payment_id)
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);

  return {
    reservation,
    totalContracted: Math.round(totalContracted * 100) / 100,
    totalPaid: Math.round(totalPaid * 100) / 100,
    outstanding: Math.max(0, Math.round((totalContracted - totalPaid) * 100) / 100),
    missedInstallments,
  };
}

async function generateDemandLetter(orgId, reservationId) {
  const history = await paymentHistory(orgId, reservationId);
  if (!history) throw Object.assign(new Error('Reservation not found'), { statusCode: 404 });

  const branding = await resolveBranding(orgId);
  const { reservation } = history;
  const customer = reservation.re_customers || {};
  const unit = reservation.re_units || {};
  const project = unit.re_projects || {};

  const companyName = branding.brand_company_name || branding.company_name || branding.full_name || 'Our Company';
  const logoUrl = branding.brand_logo_url || branding.logo_url;
  const logoBlock = (logoUrl && String(logoUrl).startsWith('https://'))
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(companyName)}">`
    : '';
  const companyAddress = branding.brand_address || branding.address || '';

  const html = fillPlaceholders(
    fs.readFileSync(TEMPLATE_PATH, 'utf8'),
    {
      COMPANY_NAME: companyName,
      COMPANY_ADDRESS_BLOCK: companyAddress,
      LOGO_BLOCK: logoBlock,
      REFERENCE_NUMBER: `DEMAND-${reservation.id.slice(0, 8).toUpperCase()}-${Date.now()}`,
      DATE: formatDate(new Date()),
      CUSTOMER_NAME: customer.full_name || 'Valued Customer',
      // re_customers carries no address column (migrations/001) — a demand
      // letter's own legal weight comes from the amounts and the deadline,
      // not from a postal address this product has never collected, so this
      // degrades to "on file" rather than blocking generation on a field
      // that does not exist anywhere in the schema to fill in.
      CUSTOMER_ADDRESS_BLOCK: 'Address on file with the developer',
      CUSTOMER_SALUTATION: customer.full_name || 'Sir/Madam',
      PROJECT_NAME: project.name || 'the development',
      PROJECT_LINE: [project.name, project.location].filter(Boolean).join(', '),
      UNIT_NUMBER: unit.unit_number || '—',
      TOTAL_CONTRACTED: naira(history.totalContracted),
      TOTAL_PAID: naira(history.totalPaid),
      AMOUNT_OUTSTANDING: naira(history.outstanding),
      MISSED_INSTALLMENTS: String(history.missedInstallments),
    },
    ['LOGO_BLOCK']
  );

  return { html, history };
}

// Renders, stores as an ordinary re_documents row (doc_type 'demand_letter',
// migrations/033) and returns it — reusing the exact render → store →
// signed-URL path documentService.js already established, rather than a
// second storage convention for one more PDF type.
async function storeDemandLetter(orgId, reservationId) {
  const { html } = await generateDemandLetter(orgId, reservationId);
  const pdf = await renderHtmlToPdf(html);
  const storagePath = `${orgId}/${reservationId}/demand_letter-${Date.now()}.pdf`;
  await uploadPdf(storagePath, pdf);

  const { data, error } = await supabaseAdmin
    .from('re_documents')
    .insert({
      organization_id: orgId,
      reservation_id: reservationId,
      doc_type: 'demand_letter',
      status: 'generated',
      storage_path: storagePath,
      generated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Cases ──────────────────────────────────────────────────────────────
async function openCase(req, { customerId, reservationId, lawyerName, lawyerPhone, lawyerEmail, notes }) {
  if (!customerId || !reservationId) {
    throw Object.assign(new Error('customer_id and reservation_id are required'), { statusCode: 400 });
  }

  const { data: reservation } = await supabaseAdmin
    .from('re_reservations')
    .select('id, customer_id')
    .eq('id', reservationId)
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (!reservation || reservation.customer_id !== customerId) {
    return { notFound: true };
  }

  const { data: legalCase, error } = await supabaseAdmin
    .from('re_legal_cases')
    .insert({
      organization_id: req.orgId,
      customer_id: customerId,
      reservation_id: reservationId,
      opened_by: req.userId,
      lawyer_name: lawyerName || null,
      lawyer_phone: lawyerPhone || null,
      lawyer_email: lawyerEmail || null,
      notes: notes || null,
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error('This reservation already has an active legal case.'), { statusCode: 409 });
    }
    throw error;
  }

  // Never let a demand letter that fails to render undo the case that was
  // just opened — the case itself is the record that matters most, the
  // same "the record is already true" rule paymentEvents.js follows.
  let demandLetter = null;
  try {
    demandLetter = await storeDemandLetter(req.orgId, reservationId);
  } catch (err) {
    console.warn('[legal] could not generate demand letter:', err.message);
  }

  audit(req, {
    action: 'legal.case_opened',
    entityType: 're_legal_cases',
    entityId: legalCase.id,
    summary: `Legal case opened for reservation ${reservationId}`,
    metadata: { customer_id: customerId, reservation_id: reservationId, demand_letter_id: demandLetter?.id || null },
  });

  const { data: customer } = await supabaseAdmin
    .from('re_customers').select('full_name, phone').eq('id', customerId).maybeSingle();
  if (customer?.phone) {
    await notify.sendWhatsApp({
      orgId: req.orgId,
      to: customer.phone,
      body: `Dear ${customer.full_name}, your account has been escalated to legal recovery due to `
        + 'outstanding arrears. A formal demand letter has been issued. Please contact our office urgently '
        + 'to resolve this matter.',
      template: 'legal_case_opened',
      relatedType: 're_customers',
      relatedId: customerId,
    });
  }

  return { ...legalCase, demand_letter: demandLetter };
}

async function listCases(orgId, status = null) {
  let query = supabaseAdmin
    .from('re_legal_cases')
    .select(`
      *, re_customers(id, full_name, phone, email),
      re_reservations(id, escalation_stage, re_units(unit_number, re_projects(name)))
    `)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function getCase(orgId, id) {
  const { data, error } = await supabaseAdmin
    .from('re_legal_cases')
    .select(`
      *, re_customers(id, full_name, phone, email),
      re_reservations(id, escalation_stage, re_units(unit_number, re_projects(name)))
    `)
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { data: demandLetters } = await supabaseAdmin
    .from('re_documents')
    .select('id, status, generated_at')
    .eq('organization_id', orgId)
    .eq('reservation_id', data.reservation_id)
    .eq('doc_type', 'demand_letter')
    .order('generated_at', { ascending: false });
  data.demand_letters = demandLetters || [];

  return data;
}

async function updateCase(req, id, updates) {
  const patch = {};
  if (updates.status !== undefined) {
    if (!STATUSES.includes(updates.status)) {
      throw Object.assign(new Error(`status must be one of: ${STATUSES.join(', ')}`), { statusCode: 400 });
    }
    patch.status = updates.status;
  }
  for (const field of ['lawyer_name', 'lawyer_phone', 'lawyer_email', 'notes']) {
    if (updates[field] !== undefined) patch[field] = updates[field] || null;
  }
  if (updates.demand_letter_sent_at !== undefined) patch.demand_letter_sent_at = updates.demand_letter_sent_at || null;
  if (updates.settlement_amount !== undefined) patch.settlement_amount = updates.settlement_amount ?? null;
  if (updates.settlement_date !== undefined) patch.settlement_date = updates.settlement_date || null;
  if (updates.court_dates !== undefined) {
    if (!Array.isArray(updates.court_dates)) {
      throw Object.assign(new Error('court_dates must be an array'), { statusCode: 400 });
    }
    patch.court_dates = updates.court_dates;
  }

  if (!Object.keys(patch).length) {
    throw Object.assign(new Error('No updatable fields provided'), { statusCode: 400 });
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('re_legal_cases')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', req.orgId)
    .select()
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error('This reservation already has an active legal case.'), { statusCode: 409 });
    }
    throw error;
  }
  if (!data) return { notFound: true };

  audit(req, {
    action: 'legal.case_updated',
    entityType: 're_legal_cases',
    entityId: data.id,
    summary: `Legal case updated: ${Object.keys(patch).filter((k) => k !== 'updated_at').join(', ')}`,
    metadata: patch,
  });

  return data;
}

// Reports screen's "Legal cases" section (owner only) — active count, total
// amount currently in dispute (the live outstanding balance on each active
// case's own reservation, not a stored figure — an active case's exposure
// changes every time the buyer pays anything, same reasoning
// investorReportService already gives for reading balances live rather than
// caching them), and what settled this calendar month.
async function summary(orgId) {
  const { data: cases, error } = await supabaseAdmin
    .from('re_legal_cases')
    .select('id, status, reservation_id, settlement_amount, settlement_date')
    .eq('organization_id', orgId);
  if (error) throw error;

  const rows = cases || [];
  const active = rows.filter((c) => c.status === 'active');

  let totalInDispute = 0;
  for (const legalCase of active) {
    try {
      const history = await paymentHistory(orgId, legalCase.reservation_id);
      if (history) totalInDispute += history.outstanding;
    } catch (err) {
      console.warn('[legal] could not compute exposure for case', legalCase.id, err.message);
    }
  }

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  const monthStartIso = monthStart.toISOString().slice(0, 10);
  const settledThisMonth = rows.filter((c) => c.status === 'settled'
    && c.settlement_date && c.settlement_date >= monthStartIso);

  return {
    active_count: active.length,
    total_in_dispute: Math.round(totalInDispute * 100) / 100,
    settled_this_month_count: settledThisMonth.length,
    settled_this_month_amount: Math.round(
      settledThisMonth.reduce((sum, c) => sum + Number(c.settlement_amount || 0), 0) * 100
    ) / 100,
  };
}

module.exports = {
  STATUSES, openCase, listCases, getCase, updateCase, summary, generateDemandLetter, storeDemandLetter, paymentHistory,
};
