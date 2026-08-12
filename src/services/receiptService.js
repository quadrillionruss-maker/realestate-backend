// receiptService.js — a buyer hands over money, a buyer gets paper.
//
// In Nigerian property transactions this is not a nicety. A buyer who
// transfers ₦2.5m and receives nothing back has no evidence they paid, and
// the first one it happens to will say so loudly. Every payment recorded by
// this service — Paystack or bank transfer — produces a receipt.
//
// Renders through the same Puppeteer adapter and lands in the same private
// bucket as the allocation letter (see documentStorage), so there is one
// answer to "where do our documents live" and one to "who can read them".

const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../middleware/orgContext');
const { renderHtmlToPdf } = require('./pdfAdapter');
const { resolveBranding, safeLogoUrl, contactLine } = require('./brandingService');
const { uploadPdf, createSignedUrl } = require('./documentStorage');
const { escapeHtml } = require('../utils/escapeHtml');
const { amountInWords } = require('../utils/amountInWords');

const TEMPLATE_PATH = path.join(__dirname, '../templates/receipt.html');

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

const formatDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const METHOD_LABELS = {
  paystack: 'Paystack (card / online transfer)',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  pos: 'POS terminal',
};

// Everything a receipt states, gathered in one query so the numbers on the
// page all describe the same instant.
async function loadPaymentContext(orgId, paymentId) {
  const { data, error } = await supabaseAdmin
    .from('re_payments')
    .select(`
      id, amount, method, paystack_reference, paid_at, overpayment, reallocated_from_payment_id,
      re_installment_schedule(
        id, installment_number, due_date, amount_due, status,
        re_installment_plans(
          id, total_amount, number_of_installments,
          re_reservations(
            id, commission_rate,
            re_customers(id, full_name, email, phone),
            re_units(unit_number, unit_type, list_price, re_projects(name, location)),
            re_sales_reps(id, commission_rate, users(full_name))
          )
        )
      )`)
    .eq('id', paymentId)
    .eq('organization_id', orgId)
    // A voided payment is money explicitly recorded as never having
    // arrived — without this, a receipt (a real receipt number and amount)
    // could still be generated, or regenerated, for it.
    .is('voided_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const schedule = data.re_installment_schedule;
  const plan = schedule?.re_installment_plans;
  const reservation = plan?.re_reservations;
  if (!reservation) return null;

  // Total paid against the whole plan, not just this installment — a receipt
  // that cannot answer "so how much is left?" sends the buyer to the phone,
  // which is the call this product exists to prevent.
  const { data: planPayments } = await supabaseAdmin
    .from('re_payments')
    .select('amount, reallocated_from_payment_id, voided_at, re_installment_schedule!inner(plan_id)')
    .eq('organization_id', orgId)
    .eq('re_installment_schedule.plan_id', plan.id);

  // A reallocation row moves credit that was already counted once, on the
  // payment it came from — summing it again here would show the buyer they
  // paid more than they actually transferred. A voided row is a payment that
  // turned out not to be real.
  const totalPaid = (planPayments || [])
    .filter((row) => !row.reallocated_from_payment_id && !row.voided_at)
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return {
    payment: data,
    schedule,
    plan,
    reservation,
    customer: reservation.re_customers || {},
    unit: reservation.re_units || {},
    project: reservation.re_units?.re_projects || {},
    salesRep: reservation.re_sales_reps || null,
    totalPaid,
    balance: Math.max(0, Number(plan.total_amount || 0) - totalPaid),
  };
}

// Exported so the offline suite can assert on a rendered receipt without a
// browser, a database or a network.
function buildReceiptHtml(context, branding = {}, receiptNumber) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const { payment, schedule, plan, customer, unit, project, totalPaid, balance } = context;

  const companyName = branding.company_name || branding.brand_company_name
    || branding.full_name || 'Our Company';

  const logo = safeLogoUrl(branding.logo_url || branding.brand_logo_url);
  const logoBlock = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(companyName)}">`
    : '';

  // A bank reference is buyer-supplied text. It is escaped like everything
  // else, and the row is omitted rather than printed empty.
  const referenceRowBlock = payment.paystack_reference
    ? `<tr><td>Reference</td><td>${escapeHtml(payment.paystack_reference)}</td></tr>`
    : '';

  const purpose = schedule
    ? `Installment ${schedule.installment_number} of ${plan.number_of_installments}, due ${formatDate(schedule.due_date)}`
    : 'Payment towards purchase';

  const installmentStatus = schedule?.status === 'paid'
    ? `Installment ${schedule.installment_number} settled in full`
    : `Installment ${schedule.installment_number} part-paid — ${naira(Number(schedule.amount_due) )} was due`;

  const fineprint = [
    contactLine(branding),
    'This is a computer-generated receipt and is valid without alteration.',
  ].filter(Boolean).join(' · ');

  return template
    .replace(/{{COMPANY_NAME}}/g, escapeHtml(companyName))
    .replace(/{{LOGO_BLOCK}}/g, logoBlock)
    .replace(/{{RECEIPT_NUMBER}}/g, escapeHtml(receiptNumber))
    .replace(/{{DATE}}/g, formatDate(new Date()))
    .replace(/{{CUSTOMER_NAME}}/g, escapeHtml(customer.full_name || ''))
    .replace(/{{AMOUNT_FORMATTED}}/g, naira(payment.amount))
    .replace(/{{AMOUNT_IN_WORDS}}/g, escapeHtml(amountInWords(payment.amount)))
    .replace(/{{PROJECT_LINE}}/g, [project.name, project.location].filter(Boolean).map(escapeHtml).join(', ') || '—')
    .replace(/{{UNIT_NUMBER}}/g, escapeHtml(unit.unit_number || '—'))
    .replace(/{{PAYMENT_PURPOSE}}/g, escapeHtml(purpose))
    .replace(/{{PAYMENT_METHOD}}/g, escapeHtml(METHOD_LABELS[payment.method] || payment.method || '—'))
    .replace(/{{REFERENCE_ROW_BLOCK}}/g, referenceRowBlock)
    .replace(/{{PAID_AT}}/g, formatDate(payment.paid_at || new Date()))
    .replace(/{{INSTALLMENT_STATUS}}/g, escapeHtml(installmentStatus))
    .replace(/{{TOTAL_PAID}}/g, naira(totalPaid))
    .replace(/{{PLAN_TOTAL}}/g, naira(plan.total_amount))
    .replace(/{{BALANCE_OUTSTANDING}}/g, naira(balance))
    .replace(/{{FINEPRINT}}/g, fineprint);
}

// Idempotent: the unique partial index on (payment_id) where doc_type =
// 'receipt' means a replayed webhook re-renders into the same row and the same
// storage path rather than producing a second receipt for one payment.
async function generateReceipt(orgId, paymentId) {
  const context = await loadPaymentContext(orgId, paymentId);
  if (!context) return { notFound: true };

  const { data: existing } = await supabaseAdmin
    .from('re_documents')
    .select('id, storage_path, status')
    .eq('organization_id', orgId)
    .eq('payment_id', paymentId)
    .eq('doc_type', 'receipt')
    .maybeSingle();
  const wasRegeneration = existing?.status === 'generated';

  let documentId = existing?.id;

  if (!documentId) {
    const { data: created, error } = await supabaseAdmin
      .from('re_documents')
      .insert({
        organization_id: orgId,
        reservation_id: context.reservation.id,
        payment_id: paymentId,
        doc_type: 'receipt',
      })
      .select('id')
      .single();

    if (error?.code === '23505') {
      // Lost a race with a concurrent generation; use the row that won.
      const { data: winner } = await supabaseAdmin
        .from('re_documents')
        .select('id')
        .eq('payment_id', paymentId)
        .eq('doc_type', 'receipt')
        .maybeSingle();
      documentId = winner?.id;
    } else if (error) {
      throw error;
    } else {
      documentId = created.id;
    }
  }
  if (!documentId) return { notFound: true };

  const receiptNumber = `RCPT-${String(documentId).slice(0, 8).toUpperCase()}`;
  const branding = await resolveBranding(orgId);
  const pdf = await renderHtmlToPdf(buildReceiptHtml(context, branding, receiptNumber));

  // Timestamped rather than a deterministic {documentId}.pdf — see
  // documentService.generateDocument for why: the DB row is correctly
  // reused (one receipt per payment still enforced there), but the OLD
  // PDF's exact bytes used to be silently overwritten in storage on every
  // regenerate. storage_path always points at the latest.
  const storagePath = `${orgId}/receipts/${documentId}/${Date.now()}.pdf`;
  await uploadPdf(storagePath, pdf);

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('re_documents')
    .update({ status: 'generated', generated_at: new Date().toISOString(), storage_path: storagePath })
    .eq('id', documentId)
    .eq('organization_id', orgId)
    .select()
    .single();
  if (updateError) throw updateError;

  return {
    document: updated,
    download_url: await createSignedUrl(storagePath),
    pdf,
    receipt_number: receiptNumber,
    was_regeneration: wasRegeneration,
    previous_storage_path: wasRegeneration ? existing.storage_path : null,
    context,
  };
}

module.exports = { generateReceipt, buildReceiptHtml, loadPaymentContext, naira, METHOD_LABELS };
