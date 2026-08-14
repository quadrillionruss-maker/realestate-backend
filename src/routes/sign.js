// routes/sign.js — SECTION 8, the buyer-facing e-signature flow.
//
// Mounted OUTSIDE `authenticate` (see server.js), same reasoning as
// routes/portal.js: the caller holds a signing link (a JWT scoped to one
// document, minted by documentService.issueSigningUrl), not a staff token,
// and the two are not interchangeable — this route never touches
// req.user/req.orgId, only whatever the token itself proves.
const express = require('express');
const rateLimit = require('express-rate-limit');
const documents = require('../services/documentService');
const { createSignedUrl } = require('../services/documentStorage');
const { callerIp } = require('../services/auditService');
const router = express.Router();

// A buyer signs a handful of documents ever, from one device, in one
// sitting — this is nowhere near normal traffic, so a tight limit here
// costs a real buyer nothing while making the token-guessing/brute-force
// case expensive. Keyed by IP since there is no caller identity yet at
// this point.
const signLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

router.use(signLimiter);

// What the buyer sees before deciding to sign: which document, for which
// unit, and a short-lived link to actually read it. Nothing here is staff
// data — the same subset loadDocumentContext already carries for the
// buyer's OWN reservation.
router.get('/:token', async (req, res, next) => {
  try {
    const { doc } = await documents.loadSigningContext(req.params.token);
    const reservation = doc.re_reservations || {};
    const unit = reservation.re_units || {};
    const project = unit.re_projects || {};

    res.json({
      doc_type: doc.doc_type,
      buyer_name: reservation.re_customers?.full_name || null,
      unit_number: unit.unit_number || null,
      project_name: project.name || null,
      preview_url: doc.storage_path ? await createSignedUrl(doc.storage_path) : null,
    });
  } catch (e) { next(e); }
});

router.post('/:token', async (req, res, next) => {
  try {
    const { signature_type: signatureType, signature_data: signatureData } = req.body || {};
    const result = await documents.applySignature(req.params.token, {
      signatureType, signatureData, ip: callerIp(req),
    });
    res.json({ signed: true, download_url: result.download_url });
  } catch (e) { next(e); }
});

module.exports = router;
