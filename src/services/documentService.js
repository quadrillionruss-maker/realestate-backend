// documentService.js — allocation letters: render, store, hand back a link.
//
// Renders with Puppeteer (via pdfAdapter) and stores in Supabase Storage.
//
// STORAGE PRIVACY: an allocation letter carries a buyer's name and what they
// paid for a house, so these go in a PRIVATE bucket and are served through
// short-lived signed URLs. What we persist on the row is the object path,
// never a bearer link.

const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../middleware/orgContext');
const { renderHtmlToPdf } = require('./pdfAdapter');
const { escapeHtml } = require('../utils/escapeHtml');
const { resolveBranding } = require('./brandingService');
const { BUCKET, SIGNED_URL_TTL_SECONDS, ensureBucket, uploadPdf, createSignedUrl } = require('./documentStorage');

// Template lives inside src/ so it travels with the code.
const TEMPLATE_PATH = path.join(__dirname, '../templates/allocation_letter.html');

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

const formatDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// Branding moved to brandingService once receipts needed the same answer —
// two copies of "whose company name wins" is how a receipt ends up branded
// differently from the letter that accompanies it. Re-exported below so
// existing callers of documentService.resolveBranding keep working.

async function loadDocumentContext(orgId, documentId) {
  const { data: doc, error } = await supabaseAdmin
    .from('re_documents')
    .select(`
      id, doc_type, status, storage_path, payment_id, created_at,
      re_reservations(
        id, reserved_at,
        re_customers(full_name, email, phone),
        re_units(unit_number, unit_type, size_sqm, list_price, re_projects(name, location)),
        re_installment_plans(total_amount, number_of_installments, frequency, start_date)
      )`)
    .eq('id', documentId)
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) throw error;
  if (!doc) return null;
  return doc;
}

function describePaymentPlan(plans, listPrice) {
  const plan = Array.isArray(plans) ? plans[0] : plans;
  if (!plan) return `Outright payment of ${naira(listPrice)}`;

  const perInstallment = Number(plan.total_amount) / Number(plan.number_of_installments);
  const cadence = plan.frequency === 'quarterly' ? 'quarterly' : 'monthly';
  return `${plan.number_of_installments} ${cadence} installments of approximately ` +
    `${naira(perInstallment)} — total ${naira(plan.total_amount)}, commencing ${formatDate(plan.start_date)}`;
}

function buildAllocationLetterHtml(doc, branding) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const reservation = doc.re_reservations || {};
  const customer = reservation.re_customers || {};
  const unit = reservation.re_units || {};
  const project = unit.re_projects || {};

  // Accepts both branding shapes: the normalized one brandingService returns,
  // and the raw users-row shape this function was originally written against.
  // The brand_* fields keep their old precedence so a profile that has both
  // still renders the way it always did.
  const companyName = branding.brand_company_name || branding.company_name
    || branding.full_name || 'Our Company';
  const logoUrl = branding.brand_logo_url || branding.logo_url;

  // Only https logos are embedded — a data: or file: URL in a Puppeteer page
  // is a way to pull local content into a customer-facing document.
  const logoBlock = (logoUrl && String(logoUrl).startsWith('https://'))
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(companyName)}">`
    : '';

  const contactLines = [customer.email, customer.phone].filter(Boolean);
  const customerContactBlock = contactLines.length
    ? '<br>' + contactLines.map((line) => escapeHtml(line)).join('<br>')
    : '';

  const sizeRowBlock = unit.size_sqm
    ? `<tr><td>Size</td><td>${escapeHtml(unit.size_sqm)} sqm</td></tr>`
    : '';

  const projectLine = [project.name, project.location].filter(Boolean).map(escapeHtml).join(', ');

  const senderContact = [
    branding.brand_address || branding.address,
    branding.brand_phone || branding.phone,
    branding.brand_website || branding.website,
  ].filter(Boolean).map(escapeHtml).join(' · ');

  // Keyed on the RESERVATION, not the document row: migrations/004/005 already
  // enforce one live allocation letter per reservation, so this is stable
  // across a re-generation and reads as "which sale" rather than "which
  // internal row" — the number a buyer, a bank, or a lawyer would actually ask
  // for later.
  const referenceNumber = `ALLOC-${String(reservation.id || doc.id).slice(0, 8).toUpperCase()}`;

  return template
    .replace(/{{COMPANY_NAME}}/g, escapeHtml(companyName))
    .replace(/{{LOGO_BLOCK}}/g, logoBlock)
    .replace(/{{REFERENCE_NUMBER}}/g, referenceNumber)
    .replace(/{{DATE}}/g, formatDate(new Date()))
    .replace(/{{CUSTOMER_NAME}}/g, escapeHtml(customer.full_name || ''))
    .replace(/{{CUSTOMER_CONTACT_BLOCK}}/g, customerContactBlock)
    .replace(/{{CUSTOMER_SALUTATION}}/g, escapeHtml(customer.full_name || 'Sir/Madam'))
    .replace(/{{PROJECT_NAME}}/g, escapeHtml(project.name || ''))
    .replace(/{{PROJECT_LINE}}/g, projectLine)
    .replace(/{{UNIT_NUMBER}}/g, escapeHtml(unit.unit_number || ''))
    .replace(/{{UNIT_TYPE}}/g, escapeHtml(unit.unit_type || '—'))
    .replace(/{{SIZE_ROW_BLOCK}}/g, sizeRowBlock)
    .replace(/{{PRICE_FORMATTED}}/g, naira(unit.list_price))
    .replace(/{{PAYMENT_PLAN_SUMMARY}}/g, escapeHtml(describePaymentPlan(reservation.re_installment_plans, unit.list_price)))
    .replace(/{{FINEPRINT}}/g, senderContact);
}

// Bucket creation, upload and signed-URL minting moved to documentStorage so
// receipts land in the same private bucket under the same rules. A receipt
// that is more public than an allocation letter is a bug nobody would notice.

// ── The one public entry point ─────────────────────────────────────────────
async function generateDocument(orgId, documentId) {
  const doc = await loadDocumentContext(orgId, documentId);
  if (!doc) return { notFound: true };

  // Receipts have their own template and their own idempotency (one per
  // payment), so they are rendered by receiptService. Required lazily: the two
  // modules would otherwise reference each other at load time.
  if (doc.doc_type === 'receipt') {
    if (!doc.payment_id) {
      return { unsupported: true, docType: 'receipt (not linked to a payment)' };
    }
    const { generateReceipt } = require('./receiptService');
    const result = await generateReceipt(orgId, doc.payment_id);
    if (result.notFound) return { notFound: true };
    return { document: result.document, download_url: result.download_url };
  }

  // Two templates ship today. Saying so beats generating a document with the
  // wrong wording on it and calling it 'generated'.
  if (doc.doc_type !== 'allocation_letter') {
    return { unsupported: true, docType: doc.doc_type };
  }

  const branding = await resolveBranding(orgId);
  const html = buildAllocationLetterHtml(doc, branding);
  const pdf = await renderHtmlToPdf(html);

  // Timestamped rather than a deterministic {documentId}.pdf: the DB row is
  // correctly reused on regeneration (one allocation letter per reservation
  // is still enforced there), but the OLD PDF's exact bytes used to be
  // silently overwritten in storage — gone the moment a letter was
  // regenerated after a branding change or a price correction, with nothing
  // left to produce in a dispute over the original wording. Each generation
  // now lands at its own path; storage_path always points at the latest.
  const wasRegeneration = doc.status === 'generated';
  const storagePath = await uploadPdf(`${orgId}/${documentId}/${Date.now()}.pdf`, pdf);

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('re_documents')
    .update({
      status: 'generated',
      generated_at: new Date().toISOString(),
      storage_path: storagePath,
    })
    .eq('id', documentId)
    .eq('organization_id', orgId)
    .select()
    .single();
  if (updateError) throw updateError;

  return {
    document: updated,
    download_url: await createSignedUrl(storagePath),
    was_regeneration: wasRegeneration,
    previous_storage_path: wasRegeneration ? doc.storage_path : null,
  };
}

async function getDownloadUrl(orgId, documentId) {
  const { data: doc } = await supabaseAdmin
    .from('re_documents')
    .select('id, storage_path')
    .eq('id', documentId)
    .eq('organization_id', orgId)
    .maybeSingle();

  if (!doc) return { notFound: true };
  if (!doc.storage_path) return { notGenerated: true };
  return { download_url: await createSignedUrl(doc.storage_path), expires_in: SIGNED_URL_TTL_SECONDS };
}

module.exports = {
  generateDocument,
  getDownloadUrl,
  buildAllocationLetterHtml,
  describePaymentPlan,
  resolveBranding,
  BUCKET,
};
