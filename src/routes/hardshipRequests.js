// routes/hardshipRequests.js — the staff side of payment pause / hardship
// mode. Submission itself happens from the buyer portal (routes/portal.js);
// this file is only ever the review queue, owner/sales_director only — see
// hardshipService.js for what approving or denying actually does.
const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const hardship = require('../services/hardshipService');
const router = express.Router();

router.get('/', requirePermission('hardship.review'), async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'denied'].includes(req.query.status) ? req.query.status : null;
    res.json(await hardship.listRequests(req.orgId, { status, customerId: req.query.customer_id || null }));
  } catch (e) { next(e); }
});

router.patch('/:id/review', requirePermission('hardship.review'), async (req, res, next) => {
  try {
    const { status } = req.body || {};
    const result = await hardship.reviewRequest(req, req.params.id, status);
    if (result.notFound) return res.status(404).json({ error: 'Hardship request not found' });
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
