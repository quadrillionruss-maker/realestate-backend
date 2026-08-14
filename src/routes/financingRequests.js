// routes/financingRequests.js — the staff side of bank financing, SECTION 9.
// Submission itself happens from the buyer portal (routes/portal.js); see
// src/services/financingService.js for what a status change actually does.
const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const financing = require('../services/financingService');
const router = express.Router();

router.get('/', requirePermission('financing.read'), async (req, res, next) => {
  try {
    const status = financing.STATUSES.includes(req.query.status) ? req.query.status : null;
    res.json(await financing.listRequests(req.orgId, status));
  } catch (e) { next(e); }
});

router.patch('/:id', requirePermission('financing.manage'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await financing.updateRequest(req, req.params.id, {
      status: body.status,
      bankReference: body.bank_reference,
      notes: body.notes,
    });
    if (result.notFound) return res.status(404).json({ error: 'Financing request not found' });
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
