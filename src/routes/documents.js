const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { generateDocument, getDownloadUrl } = require('../services/documentService');
const router = express.Router();

const DOC_TYPES = ['allocation_letter', 'deed_of_assignment', 'receipt', 'other'];
const DOC_STATUSES = ['pending', 'generated', 'sent', 'signed'];

router.get('/', async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_documents')
      .select('*, re_reservations(re_customers(full_name), re_units(unit_number, re_projects(name)))')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });

    if (req.query.status) query = query.eq('status', req.query.status);
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
        error: `No template for "${result.docType}" yet. v1 generates allocation letters only.`,
      });
    }

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
