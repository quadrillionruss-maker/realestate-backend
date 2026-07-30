const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { generateDocument, getDownloadUrl } = require('../services/documentService');
const { audit } = require('../services/auditService');
const router = express.Router();

// lease_agreement joins the enum on the same footing deed_of_assignment has
// held since v1: a real, creatable doc_type with no template yet.
// documentService.generateDocument returns { unsupported: true } for either
// today, same as it always has — this is not new behaviour, just a wider set
// of rows the "not yet" answer applies to.
const DOC_TYPES = ['allocation_letter', 'deed_of_assignment', 'lease_agreement', 'receipt', 'other'];
const DOC_STATUSES = ['pending', 'generated', 'sent', 'signed'];

router.get('/', async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_documents')
      .select('*, re_reservations(re_customers(full_name), re_units(unit_number, re_projects(name)))')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });

    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.doc_type) query = query.eq('doc_type', req.query.doc_type);
    if (req.query.reservation_id) query = query.eq('reservation_id', req.query.reservation_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { reservation_id, doc_type } = req.body || {};
    if (!reservation_id || !doc_type) {
      return res.status(400).json({ error: 'reservation_id and doc_type are required' });
    }
    if (!DOC_TYPES.includes(doc_type)) {
      return res.status(400).json({ error: `doc_type must be one of: ${DOC_TYPES.join(', ')}` });
    }

    const { data: reservation } = await supabaseAdmin
      .from('re_reservations').select('id')
      .eq('id', reservation_id).eq('organization_id', req.orgId).maybeSingle();
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

    const { data, error } = await supabaseAdmin
      .from('re_documents')
      .insert({ organization_id: req.orgId, reservation_id, doc_type })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// Render the allocation letter to PDF, store it in a private Storage bucket,
// and return a short-lived signed URL.
router.post('/:id/generate', async (req, res, next) => {
  try {
    const result = await generateDocument(req.orgId, req.params.id);

    if (result.notFound) return res.status(404).json({ error: 'Document not found' });
    if (result.unsupported) {
      return res.status(400).json({
        error: `No template for "${result.docType}" yet. Allocation letters and receipts are the two that render.`,
      });
    }

    audit(req, {
      action: 'document.generated',
      entityType: 're_documents',
      entityId: req.params.id,
      summary: `${result.document.doc_type.replace(/_/g, ' ')} generated`,
      metadata: { reservation_id: result.document.reservation_id, doc_type: result.document.doc_type },
    });

    res.json({ ...result.document, download_url: result.download_url });
  } catch (e) { next(e); }
});

// Signed links expire, so the link is minted on request rather than stored.
router.get('/:id/download', async (req, res, next) => {
  try {
    const result = await getDownloadUrl(req.orgId, req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Document not found' });
    if (result.notGenerated) {
      return res.status(409).json({ error: 'Document has not been generated yet' });
    }
    res.json(result);
  } catch (e) { next(e); }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!DOC_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${DOC_STATUSES.join(', ')}` });
    }

    const { data, error } = await supabaseAdmin
      .from('re_documents')
      .update({ status })
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Document not found' });
    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
