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
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { renderHtmlToPdf } = require('./pdfAdapter');
const { escapeHtml } = require('../utils/escapeHtml');
const { resolveBranding } = require('./brandingService');
const { auditSystem } = require('./auditService');
const notify = require('./notificationService');
const { BUCKET, SIGNED_URL_TTL_SECONDS, ensureBucket, uploadPdf, createSignedUrl } = require('./documentStorage');
const { mapWithConcurrency } = require('../utils/concurrency');
const portalNotifications = require('./portalNotificationService');
const featureUsage = require('./featureUsageService');

// Template lives inside src/ so it travels with the code.
const TEMPLATE_PATH = path.join(__dirname, '../templates/allocation_letter.html');

// ── SECTION 8 — legal documents + e-signature ───────────────────────────────
// The three "the buyer must countersign this" types. lease_agreement stays
// unsupported (same as before this section — a real doc_type with no
// template, per routes/documents.js's own comment); allocation_letter and
// receipt are informational/evidentiary, never something a buyer signs.
const SIGNABLE_DOC_TYPES = ['deed_of_assignment', 'subscriber_agreement', 'power_of_attorney'];
const LEGAL_TEMPLATE_FILES = {
  deed_of_assignment: path.join(__dirname, '../templates/deed_of_assignment.html'),
  subscriber_agreement: path.join(__dirname, '../templates/subscriber_agreement.html'),
  power_of_attorney: path.join(__dirname, '../templates/power_of_attorney.html'),
};
const SIGN_AUDIENCE = 're-document-sign';
const SIGN_TOKEN_TTL_DAYS = 14;

// SECTION 9 — every generated document (allocation letter or one of the
// three signable types) gets 90 days to be signed/acted on before the
// morning sweep (sweepExpiredDocuments below) files a task about it.
// Receipts are exempt — they are evidence of money already received, not
// something waiting on anyone to act on, so they never carry an expiry.
const EXPIRY_DAYS = 90;

// SECTION 10 — version history. Regenerating creates a NEW row and
// supersedes the old one, rather than rewriting it in place, EXCEPT for the
// very first generation (status still 'pending' — nothing exists yet to
// supersede) and receipts (their own idempotency — one receipt per payment,
// ever — lives in receiptService and is untouched by this; see that
// function's own header for why a receipt's reference number must never
// have a second version at all).
//
// The old row's own fields (including any signature it carries) are left
// exactly as they were when it is superseded — a document that WAS signed
// before being regenerated now keeps that fact on its own row, which is
// strictly more history than the in-place overwrite this replaces used to
// preserve.
async function writeGeneratedVersion(orgId, doc, updates) {
  if (doc.status === 'pending') {
    const { data: updated, error } = await supabaseAdmin
      .from('re_documents')
      .update(updates)
      .eq('id', doc.id)
      .eq('organization_id', orgId)
      .select()
      .single();
    if (error) throw error;
    featureUsage.track(orgId, 'document_generated');
    return { document: updated, wasRegeneration: false };
  }

  // superseded_at is set on the OLD row FIRST, so the two partial unique
  // indexes (uniq_re_allocation_letter_per_reservation,
  // uniq_re_documents_receipt_per_payment — migrations/043) never see two
  // live rows for the same reservation/payment at once, even for the
  // instant between these two writes.
  const { error: supersedeErr } = await supabaseAdmin
    .from('re_documents')
    .update({ status: 'superseded', superseded_at: new Date().toISOString() })
    .eq('id', doc.id)
    .eq('organization_id', orgId);
  if (supersedeErr) throw supersedeErr;

  const { data: created, error: insertErr } = await supabaseAdmin
    .from('re_documents')
    .insert({
      organization_id: orgId,
      reservation_id: doc.reservation_id,
      payment_id: doc.payment_id || null,
      doc_type: doc.doc_type,
      version: (doc.version || 1) + 1,
      ...updates,
    })
    .select()
    .single();
  if (insertErr) throw insertErr;

  const { error: linkErr } = await supabaseAdmin
    .from('re_documents')
    .update({ superseded_by: created.id })
    .eq('id', doc.id)
    .eq('organization_id', orgId);
  if (linkErr) throw linkErr;

  featureUsage.track(orgId, 'document_generated');
  return { document: created, wasRegeneration: true };
}

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
      id, doc_type, status, storage_path, payment_id, reservation_id, version, created_at,
      re_reservations(
        id, reserved_at,
        re_customers(id, full_name, email, phone),
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

// ── SECTION 8 — legal document templates (owner-customizable) ──────────────
// lowercase {{tokens}}, a DIFFERENT convention from buildAllocationLetterHtml's
// UPPERCASE_BLOCK tokens above, deliberately: these three templates are meant
// to be read and edited by a business owner in a Settings textarea (see
// routes/documents.js's template routes), so the placeholder vocabulary
// matches the plain-English names the product spec itself uses.
//
// `rawKeys` values are substituted WITHOUT escaping — used for exactly one
// key, signature_block, which legitimately contains an <img> tag or styled
// HTML. Every other value is buyer- or listing-influenced text and is
// escaped, same discipline as buildAllocationLetterHtml.
function fillPlaceholders(template, values, rawKeys = []) {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    out = out.replace(pattern, rawKeys.includes(key) ? String(value ?? '') : escapeHtml(String(value ?? '')));
  }
  return out;
}

// An org's own override (Settings → Document templates) if it has saved one,
// else the shipped default. Absent-row means default — see migrations/027's
// own comment on why "a row exists but is empty" is never a state this
// product produces.
async function getLegalTemplateHtml(orgId, docType) {
  const { data } = await supabaseAdmin
    .from('re_document_templates')
    .select('template_html')
    .eq('organization_id', orgId)
    .eq('doc_type', docType)
    .maybeSingle();
  if (data?.template_html) return data.template_html;
  return fs.readFileSync(LEGAL_TEMPLATE_FILES[docType], 'utf8');
}

function unsignedSignatureBlockHtml() {
  return '<div class="signature-line">Signature: _____________________________</div>';
}

// A drawn signature is a PNG data URL captured from the buyer's own browser
// canvas; a typed one is rendered in a cursive-styled font so it reads as a
// signature rather than plain body text. Either way the exact moment is
// printed alongside it — the same "who, and when" a wet-ink signature block
// would carry.
function signedSignatureBlockHtml(doc) {
  const signedLine = `Signed ${formatDate(doc.signed_at)}`;
  const inner = doc.signature_type === 'drawn'
    ? `<img src="${escapeHtml(doc.signature_data)}" style="max-width:260px;max-height:80px;display:block;border-bottom:1px solid #1a1a1a;padding-bottom:4px" alt="Signature">`
    : `<div style="font-family:'Brush Script MT',cursive;font-size:22pt;border-bottom:1px solid #1a1a1a;padding-bottom:4px;display:inline-block">${escapeHtml(doc.signature_data)}</div>`;
  return `${inner}<div style="font-size:9.5pt;color:#555;margin-top:4px">${escapeHtml(signedLine)}</div>`;
}

async function buildLegalDocumentHtml(orgId, doc, branding, { signed = false } = {}) {
  const template = await getLegalTemplateHtml(orgId, doc.doc_type);
  const reservation = doc.re_reservations || {};
  const customer = reservation.re_customers || {};
  const unit = reservation.re_units || {};
  const project = unit.re_projects || {};
  const plan = Array.isArray(reservation.re_installment_plans)
    ? reservation.re_installment_plans[0] : reservation.re_installment_plans;

  const companyName = branding.brand_company_name || branding.company_name || branding.full_name || 'Our Company';
  // Same "keyed on the reservation, not the document row" reasoning
  // buildAllocationLetterHtml's own reference number uses, prefixed by doc
  // type so a buyer holding several documents can tell them apart at a
  // glance.
  const referenceNumber = `${doc.doc_type.slice(0, 3).toUpperCase()}-${String(reservation.id || doc.id).slice(0, 8).toUpperCase()}`;

  const values = {
    company_name: companyName,
    buyer_name: customer.full_name || '',
    unit_number: unit.unit_number || '',
    unit_type: unit.unit_type || '—',
    project_name: project.name || '',
    project_location: project.location || '',
    project_line: [project.name, project.location].filter(Boolean).join(', '),
    total_amount: naira(plan?.total_amount ?? unit.list_price),
    date: formatDate(new Date()),
    reference_number: referenceNumber,
    // Raw HTML — deliberately not escaped, see fillPlaceholders' rawKeys.
    signature_block: signed ? signedSignatureBlockHtml(doc) : unsignedSignatureBlockHtml(),
  };

  return fillPlaceholders(template, values, ['signature_block']);
}

// ── SECTION 8 — e-signature ─────────────────────────────────────────────────
// The signing link is a JWT, the exact shape portalService.issuePortalToken
// already uses for a buyer's account link — signed with JWT_SECRET,
// self-verifying, nothing stored in the database for it. See
// migrations/027's own comment for why a signed document needs no separate
// revoke mechanism the way a portal link's token_version does.
function issueSigningUrl(doc) {
  if (!env.appUrl) return null; // no known frontend host to build a usable link against
  const token = jwt.sign(
    { did: doc.id, org: doc.organization_id },
    env.jwt.secret,
    { algorithm: 'HS256', audience: SIGN_AUDIENCE, expiresIn: `${SIGN_TOKEN_TTL_DAYS}d` }
  );
  return `${env.appUrl}/sign.html#token=${token}`;
}

function verifySigningToken(token) {
  try {
    return jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'], audience: SIGN_AUDIENCE });
  } catch (err) {
    throw Object.assign(
      new Error(err.name === 'TokenExpiredError' ? 'This signing link has expired.' : 'This signing link is not valid.'),
      { statusCode: 401 }
    );
  }
}

// The one entry point sign.js (the buyer-facing page) calls for both GET
// (show the document) and POST (submit a signature) — same claims, same
// checks, so the two can never disagree about whether a link is still good.
async function loadSigningContext(token) {
  const claims = verifySigningToken(token);
  const doc = await loadDocumentContext(claims.org, claims.did);
  if (!doc) throw Object.assign(new Error('This document could not be found.'), { statusCode: 404 });
  if (doc.signed_at) throw Object.assign(new Error('This document has already been signed.'), { statusCode: 409 });
  if (!SIGNABLE_DOC_TYPES.includes(doc.doc_type)) {
    throw Object.assign(new Error('This document type does not support e-signature.'), { statusCode: 400 });
  }
  return { doc, orgId: claims.org };
}

async function applySignature(token, { signatureType, signatureData, ip }) {
  if (!['drawn', 'typed'].includes(signatureType)) {
    throw Object.assign(new Error('signature_type must be drawn or typed.'), { statusCode: 400 });
  }
  if (!signatureData || typeof signatureData !== 'string') {
    throw Object.assign(new Error('signature_data is required.'), { statusCode: 400 });
  }
  if (signatureType === 'drawn' && !signatureData.startsWith('data:image/png;base64,')) {
    throw Object.assign(new Error('A drawn signature must be a PNG image.'), { statusCode: 400 });
  }
  if (signatureType === 'typed' && signatureData.trim().length > 200) {
    throw Object.assign(new Error('Typed signature is too long.'), { statusCode: 400 });
  }

  const { doc, orgId } = await loadSigningContext(token);
  const branding = await resolveBranding(orgId);
  const signedAt = new Date().toISOString();

  // Rendered with the signature already in it — the stored PDF is the exact
  // document the buyer read and signed, not the unsigned one with a
  // signature bolted on as metadata nobody can see without opening this row.
  const html = await buildLegalDocumentHtml(
    orgId,
    { ...doc, signed_at: signedAt, signature_type: signatureType, signature_data: signatureData },
    branding,
    { signed: true }
  );
  const pdf = await renderHtmlToPdf(html);
  const signedPath = await uploadPdf(`${orgId}/${doc.id}/signed-${Date.now()}.pdf`, pdf);

  const { data: updated, error } = await supabaseAdmin
    .from('re_documents')
    .update({
      status: 'signed',
      signed_at: signedAt,
      signed_ip: ip || null,
      signature_data: signatureData,
      signature_type: signatureType,
      signed_storage_path: signedPath,
    })
    .eq('id', doc.id)
    .eq('organization_id', orgId)
    .select()
    .single();
  if (error) throw error;

  await auditSystem({
    orgId,
    action: 'document.signed',
    entityType: 're_documents',
    entityId: doc.id,
    summary: `${doc.doc_type.replace(/_/g, ' ')} signed by the buyer`,
    metadata: { signature_type: signatureType, signed_ip: ip || null },
  });

  return { document: updated, download_url: await createSignedUrl(signedPath) };
}

// Fired once, right after a signable document is first generated — never
// blocks generation on a send failure, same rule notificationService.js's
// own three rules establish for every other send in this product.
async function notifySigningLink(orgId, doc, signingUrl) {
  if (!signingUrl) return;
  const customer = doc.re_reservations?.re_customers;
  if (!customer) return;

  const label = doc.doc_type.replace(/_/g, ' ');
  const message = `Hi ${customer.full_name || 'there'}, your ${label} is ready to review and sign: ${signingUrl}`;

  if (customer.email) {
    const defaultHtml = notify.emailShell({
      heading: `Please sign your ${label}`,
      intro: `Your ${label} is ready. Please review it and sign using the button below.`,
      ctaLabel: 'Review & sign',
      ctaUrl: signingUrl,
    });

    // SECTION 14 — a workspace's own document_ready template, if saved, wins.
    const content = await notify.resolveEmailContent(orgId, 'document_ready', {
      buyer_name: customer.full_name || '',
      amount: '',
      unit: doc.re_reservations?.re_units?.unit_number || '',
      due_date: '',
      portal_link: signingUrl,
    }, { subject: `Please sign your ${label}`, html: defaultHtml });

    await notify.sendEmail({
      orgId,
      to: customer.email,
      subject: content.subject,
      html: content.html,
      text: message,
      template: 'document_signing_link',
      relatedType: 're_documents',
      relatedId: doc.id,
    });
  }
  if (customer.phone) {
    await notify.sendWhatsApp({
      orgId, to: customer.phone, body: message,
      template: 'document_signing_link', relatedType: 're_documents', relatedId: doc.id,
    });
  }
}

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

  if (doc.doc_type === 'allocation_letter') {
    const branding = await resolveBranding(orgId);
    const html = buildAllocationLetterHtml(doc, branding);
    const pdf = await renderHtmlToPdf(html);

    // Timestamped rather than a deterministic {documentId}.pdf — SECTION 10
    // now gives a regeneration its own ROW too (writeGeneratedVersion), but
    // the storage path was already unique per render before that, and stays
    // that way: the exact bytes of every version, signed or not, survive in
    // Storage regardless of what the database row does with them.
    const wasRegeneration = doc.status !== 'pending';
    const storagePath = await uploadPdf(`${orgId}/${documentId}/${Date.now()}.pdf`, pdf);
    const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 86_400_000).toISOString();

    const { document: written } = await writeGeneratedVersion(orgId, doc, {
      status: 'generated',
      generated_at: new Date().toISOString(),
      storage_path: storagePath,
      expires_at: expiresAt,
    });

    // SECTION 20 — the portal bell.
    const allocationCustomer = doc.re_reservations?.re_customers;
    if (allocationCustomer?.id) {
      await portalNotifications.notify(orgId, allocationCustomer.id, 'document_ready',
        'Your allocation letter is ready', 'You can download it from your account.');
    }

    return {
      document: written,
      download_url: await createSignedUrl(storagePath),
      was_regeneration: wasRegeneration,
      previous_storage_path: wasRegeneration ? doc.storage_path : null,
    };
  }

  // SECTION 8 — deed_of_assignment, subscriber_agreement, power_of_attorney.
  // Everything else (lease_agreement, other) has no template yet, exactly as
  // before this section.
  if (!SIGNABLE_DOC_TYPES.includes(doc.doc_type)) {
    return { unsupported: true, docType: doc.doc_type };
  }

  const branding = await resolveBranding(orgId);
  const html = await buildLegalDocumentHtml(orgId, doc, branding, { signed: false });
  const pdf = await renderHtmlToPdf(html);

  const wasRegeneration = doc.status === 'generated' || doc.status === 'sent' || doc.status === 'signed';
  const storagePath = await uploadPdf(`${orgId}/${documentId}/${Date.now()}.pdf`, pdf);
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 86_400_000).toISOString();

  // SECTION 10 — a regeneration now supersedes the OLD row rather than
  // wiping its signature fields in place: the old row keeps whatever it
  // signed_at/signed_storage_path it had, as its own permanent record, and
  // the NEW row (written_via writeGeneratedVersion) starts genuinely clean —
  // there is nothing to null out any more, because it never had a signature
  // to begin with.
  const { document: written } = await writeGeneratedVersion(orgId, doc, {
    status: 'generated',
    generated_at: new Date().toISOString(),
    storage_path: storagePath,
    expires_at: expiresAt,
  });

  const signingUrl = issueSigningUrl(written);
  await notifySigningLink(orgId, doc, signingUrl);

  // SECTION 20 — the portal bell. notifySigningLink above already emails/
  // WhatsApps the buyer directly; this is the separate in-app bell entry,
  // same "two channels, two calls" reasoning paymentEvents.js's push vs
  // portal-notification split already follows.
  const legalDocCustomer = doc.re_reservations?.re_customers;
  if (legalDocCustomer?.id) {
    await portalNotifications.notify(orgId, legalDocCustomer.id, 'document_ready',
      `Your ${doc.doc_type.replace(/_/g, ' ')} is ready to sign`, 'You can review and sign it from your account.');
  }

  return {
    document: written,
    download_url: await createSignedUrl(storagePath),
    was_regeneration: wasRegeneration,
    previous_storage_path: wasRegeneration ? doc.storage_path : null,
    signing_url: signingUrl,
  };
}

async function getDownloadUrl(orgId, documentId) {
  const { data: doc } = await supabaseAdmin
    .from('re_documents')
    .select('id, storage_path, signed_storage_path')
    .eq('id', documentId)
    .eq('organization_id', orgId)
    .maybeSingle();

  if (!doc) return { notFound: true };
  // Once signed, the signed PDF — the exact bytes the buyer actually read
  // and signed — is what "download this document" means; the unsigned one
  // stays in storage but is no longer the one anybody asking for this
  // document wants.
  const path = doc.signed_storage_path || doc.storage_path;
  if (!path) return { notGenerated: true };
  return { download_url: await createSignedUrl(path), expires_in: SIGNED_URL_TTL_SECONDS, signed: Boolean(doc.signed_storage_path) };
}

const SWEEP_CONCURRENCY = 8;

// SECTION 9 — platform-wide, run once a day from jobs/daily.js, after the
// brief (this is housekeeping, not something the brief needs to read). Files
// one task per document that crossed its own expires_at while still
// 'generated' or 'sent' — never 'pending' (nothing was ever issued) or
// 'signed'/'superseded' (resolved, one way or the other). Title-match
// dedupe against open AI tasks, the exact same idempotency
// rentalService.checkTenancyRenewals uses for the same reason: a sweep that
// runs every morning for months must not re-file the same warning forever.
async function sweepExpiredDocuments() {
  const nowIso = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('re_documents')
    .select(`
      id, doc_type, status, expires_at, organization_id, reservation_id,
      re_reservations(re_customers(full_name), re_units(unit_number, re_projects(name)))`)
    .in('status', ['generated', 'sent'])
    .not('expires_at', 'is', null)
    .lt('expires_at', nowIso);
  if (error) throw error;

  let filed = 0;

  await mapWithConcurrency(data || [], SWEEP_CONCURRENCY, async (doc) => {
    const buyerName = doc.re_reservations?.re_customers?.full_name || 'a buyer';
    const unit = doc.re_reservations?.re_units;
    const unitLabel = unit?.unit_number
      ? `Unit ${unit.unit_number}${unit.re_projects?.name ? ` (${unit.re_projects.name})` : ''}`
      : 'a unit';
    const title = `Document expired unsigned — ${buyerName} — ${doc.doc_type.replace(/_/g, ' ')} — ${unitLabel}`;

    const { data: existing } = await supabaseAdmin
      .from('re_tasks')
      .select('id')
      .eq('organization_id', doc.organization_id)
      .eq('title', title)
      .eq('status', 'open')
      .eq('source', 'ai')
      .limit(1)
      .maybeSingle();
    if (existing) return;

    const { error: insertError } = await supabaseAdmin.from('re_tasks').insert({
      organization_id: doc.organization_id,
      title,
      notes: `Expired ${doc.expires_at.slice(0, 10)} without being signed or marked sent. Regenerate it from the `
        + 'Documents screen if it is still needed, or follow up with the buyer.',
      related_reservation_id: doc.reservation_id,
      source: 'ai',
    });
    if (insertError) {
      if (insertError.code !== '23505') console.warn('[documents] could not file expiry task:', insertError.message);
      return;
    }
    filed += 1;

    await auditSystem({
      orgId: doc.organization_id,
      actorKind: 'system',
      action: 'document.expired',
      entityType: 're_documents',
      entityId: doc.id,
      summary: `${doc.doc_type.replace(/_/g, ' ')} for ${buyerName} expired unsigned`,
      metadata: { expires_at: doc.expires_at },
    });
  });

  return { evaluated: (data || []).length, filed };
}

module.exports = {
  generateDocument,
  getDownloadUrl,
  buildAllocationLetterHtml,
  describePaymentPlan,
  resolveBranding,
  BUCKET,
  // SECTION 8
  SIGNABLE_DOC_TYPES,
  fillPlaceholders,
  getLegalTemplateHtml,
  buildLegalDocumentHtml,
  issueSigningUrl,
  verifySigningToken,
  loadSigningContext,
  applySignature,
  loadDocumentContext,
  // SECTION 9
  sweepExpiredDocuments,
  EXPIRY_DAYS,
};
