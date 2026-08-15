const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission, isOwnRecordsOnly, salesRepIdsFor, MATCHES_NOTHING } = require('../middleware/rbac');
const { generateDocument, getDownloadUrl, SIGNABLE_DOC_TYPES, getLegalTemplateHtml } = require('../services/documentService');
const { audit } = require('../services/auditService');
const router = express.Router();

// TASK 3 AUDIT FIX (Important #6) — pdfAdapter.js renders through a real
// headless Chromium per call (Puppeteer), CPU/memory-heavy in a way list/
// download/status routes on this same file are not. Same reasoning and
// shape as briefGenerateLimiter/importLimiter: nothing but the generic
// 600/15min global budget stood between a documents.generate-level account
// and repeatedly spinning up Chromium.
const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  message: { error: 'Too many document generations. Wait a few minutes and try again.' },
});

// lease_agreement joins the enum on the same footing deed_of_assignment has
// held since v1: a real, creatable doc_type with no template yet.
// documentService.generateDocument returns { unsupported: true } for either
// today, same as it always has — this is not new behaviour, just a wider set
// of rows the "not yet" answer applies to. deed_of_assignment,
// subscriber_agreement and power_of_attorney (SECTION 8) DO now render —
// SIGNABLE_DOC_TYPES is documentService's own list of exactly those three.
const DOC_TYPES = ['allocation_letter', 'deed_of_assignment', 'lease_agreement',
  'subscriber_agreement', 'power_of_attorney', 'receipt', 'other'];
const DOC_STATUSES = ['pending', 'generated', 'sent', 'signed'];

// A Sales Executive's own reservation ids — documents are scoped to them
// through reservation_id, not a column of their own, so this is one extra
// read rather than a filterable column. Returns null for every other role,
// meaning "don't filter" to the two call sites below.
async function ownReservationIdsFor(req) {
  if (!isOwnRecordsOnly(req.orgRole)) return null;
  const repIds = await salesRepIdsFor(req);
  if (!repIds.length) return [];
  const { data } = await supabaseAdmin
    .from('re_reservations').select('id')
    .eq('organization_id', req.orgId).in('sales_rep_id', repIds);
  return (data || []).map((r) => r.id);
}

router.get('/', requirePermission('documents.read'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_documents')
      .select('*, re_reservations(re_customers(full_name), re_units(unit_number, re_projects(name)))')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });

    const ownReservationIds = await ownReservationIdsFor(req);
    if (ownReservationIds !== null) {
      query = query.in('reservation_id', ownReservationIds.length ? ownReservationIds : [MATCHES_NOTHING]);
    }

    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.doc_type) query = query.eq('doc_type', req.query.doc_type);
    if (req.query.reservation_id) query = query.eq('reservation_id', req.query.reservation_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// "Request a document" (Sales Executive) and "raise the row I'm about to
// generate" (Documentation) are the same insert — status stays 'pending'
// either way, and POST /:id/generate below is the separate, PAPERWORK-tier
// step that actually renders it. A rep may only request one against their
// own reservation.
router.post('/', requirePermission('documents.create'), async (req, res, next) => {
  try {
    const { reservation_id, doc_type } = req.body || {};
    if (!reservation_id || !doc_type) {
      return res.status(400).json({ error: 'reservation_id and doc_type are required' });
    }
    if (!DOC_TYPES.includes(doc_type)) {
      return res.status(400).json({ error: `doc_type must be one of: ${DOC_TYPES.join(', ')}` });
    }

    let reservationQuery = supabaseAdmin
      .from('re_reservations').select('id')
      .eq('id', reservation_id).eq('organization_id', req.orgId);
    if (isOwnRecordsOnly(req.orgRole)) {
      const repIds = await salesRepIdsFor(req);
      reservationQuery = reservationQuery.in('sales_rep_id', repIds.length ? repIds : [MATCHES_NOTHING]);
    }
    const { data: reservation } = await reservationQuery.maybeSingle();
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

    const { data, error } = await supabaseAdmin
      .from('re_documents')
      .insert({ organization_id: req.orgId, reservation_id, doc_type })
      .select()
      .single();
    if (error) {
      // uniq_re_allocation_letter_per_reservation (migrations/005) blocks a
      // second live allocation letter for the same reservation — point the
      // caller at the one that already exists instead of a raw 500.
      if (error.code === '23505') {
        const { data: existingDoc } = await supabaseAdmin
          .from('re_documents')
          .select()
          .eq('reservation_id', reservation_id)
          .eq('doc_type', doc_type)
          .maybeSingle();
        return res.status(409).json({
          error: 'An allocation letter already exists for this reservation. Regenerate it instead of creating a new one.',
          document: existingDoc || null,
        });
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// Render the allocation letter to PDF, store it in a private Storage bucket,
// and return a short-lived signed URL. Owner, Sales Director or
// Documentation only — a Sales Executive can request a document above but
// never issues one themselves.
router.post('/:id/generate', generateLimiter, requirePermission('documents.generate'), async (req, res, next) => {
  try {
    const result = await generateDocument(req.orgId, req.params.id);

    if (result.notFound) return res.status(404).json({ error: 'Document not found' });
    if (result.unsupported) {
      return res.status(400).json({
        error: `No template for "${result.docType}" yet. Allocation letters, receipts, deeds of assignment, `
          + `subscriber's agreements and powers of attorney are the ones that render.`,
      });
    }

    audit(req, {
      action: result.was_regeneration ? 'document.regenerated' : 'document.generated',
      entityType: 're_documents',
      entityId: req.params.id,
      summary: `${result.document.doc_type.replace(/_/g, ' ')} ${result.was_regeneration ? 'regenerated' : 'generated'}`
        // SECTION 8 — a signing link only exists for the three signable
        // types (documentService.notifySigningLink), so this only appends
        // for those.
        + (result.signing_url ? ' — signing link sent to the buyer' : ''),
      metadata: {
        reservation_id: result.document.reservation_id,
        doc_type: result.document.doc_type,
        previous_storage_path: result.previous_storage_path || undefined,
      },
    });

    // signing_url is included so staff can also copy/share it directly
    // (WhatsApp Web, say) — the automatic email/WhatsApp send is
    // best-effort and a buyer with neither on file would otherwise have no
    // way to get this document at all.
    res.json({ ...result.document, download_url: result.download_url, signing_url: result.signing_url || null });
  } catch (e) { next(e); }
});

// Signed links expire, so the link is minted on request rather than stored.
router.get('/:id/download', requirePermission('documents.download'), async (req, res, next) => {
  try {
    const result = await getDownloadUrl(req.orgId, req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Document not found' });
    if (result.notGenerated) {
      return res.status(409).json({ error: 'Document has not been generated yet' });
    }
    res.json(result);
  } catch (e) { next(e); }
});

router.patch('/:id/status', requirePermission('documents.updateStatus'), async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!DOC_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${DOC_STATUSES.join(', ')}` });
    }

    const { data: existing } = await supabaseAdmin
      .from('re_documents').select('id, doc_type, status')
      .eq('id', req.params.id).eq('organization_id', req.orgId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Document not found' });

    const { data, error } = await supabaseAdmin
      .from('re_documents')
      .update({ status })
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Document not found' });

    // "Signed" in particular is a legally significant fact — the record
    // that a buyer countersigned. Without this, a dispute over whether a
    // letter was ever executed had nothing beyond the bare current value to
    // point to.
    audit(req, {
      action: 'document.status_changed',
      entityType: 're_documents',
      entityId: data.id,
      summary: `${existing.doc_type.replace(/_/g, ' ')} moved from ${existing.status} to ${status}`,
      metadata: { from: existing.status, to: status },
    });

    res.json(data);
  } catch (e) { next(e); }
});

// ── SECTION 8 — document template editor ────────────────────────────────────
// Owner only (settings.write) — same tier as every other piece of workspace
// configuration in routes/settings.js. Kept here rather than there because
// this is squarely about documents, not about the workspace's own identity
// or provider keys.
router.get('/templates', requirePermission('settings.write'), async (req, res, next) => {
  try {
    const { data: overrides, error } = await supabaseAdmin
      .from('re_document_templates')
      .select('doc_type, template_html, updated_at')
      .eq('organization_id', req.orgId);
    if (error) throw error;

    const byType = new Map((overrides || []).map((o) => [o.doc_type, o]));
    const templates = await Promise.all(SIGNABLE_DOC_TYPES.map(async (docType) => {
      const override = byType.get(docType);
      return {
        doc_type: docType,
        is_custom: Boolean(override),
        updated_at: override?.updated_at || null,
        template_html: override?.template_html || await getLegalTemplateHtml(req.orgId, docType),
      };
    }));

    res.json(templates);
  } catch (e) { next(e); }
});

// An empty/omitted template_html resets to the shipped default (deletes the
// override row) — same "blank clears it" convention routes/settings.js uses
// for a workspace's own provider keys.
router.put('/templates/:docType', requirePermission('settings.write'), async (req, res, next) => {
  try {
    const docType = req.params.docType;
    if (!SIGNABLE_DOC_TYPES.includes(docType)) {
      return res.status(400).json({ error: `docType must be one of: ${SIGNABLE_DOC_TYPES.join(', ')}` });
    }

    const html = String(req.body?.template_html || '').trim();

    if (!html) {
      await supabaseAdmin.from('re_document_templates')
        .delete().eq('organization_id', req.orgId).eq('doc_type', docType);
      audit(req, {
        action: 'document_template.reset',
        entityType: 're_document_templates',
        summary: `${docType.replace(/_/g, ' ')} template reset to the default`,
      });
      return res.json({ doc_type: docType, is_custom: false, template_html: await getLegalTemplateHtml(req.orgId, docType) });
    }

    // Missing the reserved {{signature_block}} token would silently strip
    // the buyer's actual signature out of the document that gets stored as
    // evidence — see documentService.buildLegalDocumentHtml. Caught here,
    // at save time, rather than discovered the day a buyer's signed PDF
    // turns out to have never carried one.
    if (!/{{\s*signature_block\s*}}/.test(html)) {
      return res.status(400).json({ error: 'The template must include a {{signature_block}} placeholder for the buyer\'s signature.' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_document_templates')
      .upsert({ organization_id: req.orgId, doc_type: docType, template_html: html, updated_at: new Date().toISOString() },
        { onConflict: 'organization_id,doc_type' })
      .select()
      .single();
    if (error) throw error;

    audit(req, {
      action: 'document_template.updated',
      entityType: 're_document_templates',
      entityId: data.id,
      summary: `${docType.replace(/_/g, ' ')} template customized`,
    });

    res.json({ doc_type: docType, is_custom: true, template_html: data.template_html, updated_at: data.updated_at });
  } catch (e) { next(e); }
});

module.exports = router;
