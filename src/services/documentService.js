// documentService.js — allocation letters: render, store, hand back a link.
//
// Reuses FlowDesk's Puppeteer service (via pdfAdapter) and Supabase Storage,
// the same two pieces that already produce invoice PDFs and host logo uploads.
//
// STORAGE PRIVACY: logos live in a public bucket because they are public.
// An allocation letter carries a buyer's name and what they paid for a house,
// so these go in a PRIVATE bucket and are served through short-lived signed
// URLs. What we persist on the row is the object path, never a bearer link.

const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../middleware/orgContext');
const { renderHtmlToPdf } = require('./pdfAdapter');
const { escapeHtml } = require('../utils/escapeHtml');

// Template lives inside src/ so this path holds both in a standalone checkout
// and after the module is copied to FlowDesk's src/re/.
const TEMPLATE_PATH = path.join(__dirname, '../templates/allocation_letter.html');
const BUCKET = process.env.RE_DOCUMENTS_BUCKET || 're-documents';
const SIGNED_URL_TTL_SECONDS = 300;

const naira = (amount) =>
  '₦' + Number(amount || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });

const formatDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// ── Branding ───────────────────────────────────────────────────────────────
// organization_id is a team id or a user id (see migrations/001). Letterhead
// details live on the FlowDesk user profile, so resolve whichever it is.
async function resolveBranding(orgId) {
  const profileColumns = 'full_name, company_name, brand_company_name, brand_logo_url, brand_address, brand_phone, brand_website';

  const { data: soloUser } = await supabaseAdmin
    .from('users')
    .select(profileColumns)
    .eq('id', orgId)
    .maybeSingle();
  if (soloUser) return soloUser;

  const { data: team } = await supabaseAdmin
    .from('teams')
    .select('name, owner_id')
    .eq('id', orgId)
    .maybeSingle();

  if (team?.owner_id) {
    const { data: owner } = await supabaseAdmin
      .from('users')
      .select(profileColumns)
      .eq('id', team.owner_id)
      .maybeSingle();
    // The team's own name wins over the owner's personal company name.
    if (owner) return { ...owner, company_name: team.name || owner.company_name };
  }

  return team ? { company_name: team.name } : {};
}

async function loadDocumentContext(orgId, documentId) {
  const { data: doc, error } = await supabaseAdmin
    .from('re_documents')
    .select(`
      id, doc_type, status, storage_path, created_at,
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

  const companyName = branding.brand_company_name || branding.company_name || branding.full_name || 'Our Company';

  // Only https logos are embedded — a data: or file: URL in a Puppeteer page
  // is a way to pull local content into a customer-facing document.
  const logoBlock = (branding.brand_logo_url && branding.brand_logo_url.startsWith('https://'))
    ? `<img src="${escapeHtml(branding.brand_logo_url)}" alt="${escapeHtml(companyName)}">`
    : '';

  const contactLines = [customer.email, customer.phone].filter(Boolean);
  const customerContactBlock = contactLines.length
    ? '<br>' + contactLines.map((line) => escapeHtml(line)).join('<br>')
    : '';

  const sizeRowBlock = unit.size_sqm
    ? `<tr><td>Size</td><td>${escapeHtml(unit.size_sqm)} sqm</td></tr>`
    : '';

  const projectLine = [project.name, project.location].filter(Boolean).map(escapeHtml).join(', ');

  const senderContact = [branding.brand_address, branding.brand_phone, branding.brand_website]
    .filter(Boolean).map(escapeHtml).join(' · ');

  return template
    .replace(/{{COMPANY_NAME}}/g, escapeHtml(companyName))
    .replace(/{{LOGO_BLOCK}}/g, logoBlock)
    .replace(/{{REFERENCE_NUMBER}}/g, `ALLOC-${String(doc.id).slice(0, 8).toUpperCase()}`)
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

// Created on first use so deployment doesn't need a manual Storage step.
// Private: these documents are only ever reachable through a signed URL.
async function ensureBucket() {
  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  if ((buckets || []).some((b) => b.name === BUCKET)) return;

  const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: '10MB',
    allowedMimeTypes: ['application/pdf'],
  });
  // A parallel request may have created it between the check and the call.
  if (error && !/already exists/i.test(error.message)) throw error;
}

async function createSignedUrl(storagePath) {
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

// ── The one public entry point ─────────────────────────────────────────────
async function generateDocument(orgId, documentId) {
  const doc = await loadDocumentContext(orgId, documentId);
  if (!doc) return { notFound: true };

  // v1 ships one template. Saying so beats generating a letter with the wrong
  // wording on it and calling the document 'generated'.
  if (doc.doc_type !== 'allocation_letter') {
    return { unsupported: true, docType: doc.doc_type };
  }

  const branding = await resolveBranding(orgId);
  const html = buildAllocationLetterHtml(doc, branding);
  const pdf = await renderHtmlToPdf(html);

  await ensureBucket();
  const storagePath = `${orgId}/${documentId}.pdf`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true });
  if (uploadError) throw uploadError;

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

  return { document: updated, download_url: await createSignedUrl(storagePath) };
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
