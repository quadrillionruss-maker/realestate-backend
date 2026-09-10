// routes/approvals.js — PROMPT 8, the Unified Approval/Workflow Engine's
// own HTTP surface. GET /pending is the one queue across every request
// type; POST /:id/approve and /:id/reject are thin routers, not a second
// copy of any flow's own business logic — they look up which request_type
// a row is, re-check THAT type's real permission (approvalService.js's own
// REQUEST_TYPE_PERMISSION map), and delegate to the exact same service
// function the flow's own existing route already calls
// (hardshipService.reviewRequest, financingService.updateRequest). The
// flow-specific routes (routes/hardshipRequests.js's PATCH /:id/review,
// routes/financingRequests.js's PATCH /:id) are untouched and still work —
// this is a second door into the same room, not a replacement for the
// first.
//
// restructure and bulk_waive never appear here as 'pending' — they have no
// separate request/decide step today (migrations/092's own header) and are
// recorded already resolved, so a lookup that somehow finds one 'pending'
// (it should be structurally impossible) 409s rather than guessing at an
// approval action neither flow actually exposes.
const express = require('express');
const { requirePermission, assertPermission } = require('../middleware/rbac');
const approvals = require('../services/approvalService');
const hardship = require('../services/hardshipService');
const financing = require('../services/financingService');
const router = express.Router();

router.get('/pending', requirePermission('approvals.view'), async (req, res, next) => {
  try {
    res.json(await approvals.listPending(req.orgId));
  } catch (e) { next(e); }
});

async function decide(req, res, next, { rejecting }) {
  try {
    const row = await approvals.getById(req.orgId, req.params.id);
    if (!row) return res.status(404).json({ error: 'Approval request not found' });
    if (row.status !== 'pending') {
      return res.status(409).json({ error: 'This request has already been decided.' });
    }

    const permission = approvals.REQUEST_TYPE_PERMISSION[row.request_type];
    if (!permission || !assertPermission(req, res, permission)) return;

    if (row.request_type === 'hardship') {
      const result = await hardship.reviewRequest(req, row.entity_id, rejecting ? 'denied' : 'approved');
      if (result.notFound) return res.status(404).json({ error: 'The underlying hardship request was not found.' });
      return res.json(result);
    }

    if (row.request_type === 'financing') {
      const reason = String(req.body?.rejection_reason || '').trim();
      const result = await financing.updateRequest(req, row.entity_id, {
        status: rejecting ? 'rejected' : 'approved',
        notes: rejecting && reason ? reason : undefined,
      });
      if (result.notFound) return res.status(404).json({ error: 'The underlying financing request was not found.' });
      return res.json(result);
    }

    // restructure / bulk_waive / any reserved type — written already
    // resolved (migrations/092's header), so a row of this type should
    // never actually be 'pending'. Defensive, not expected to fire.
    return res.status(409).json({ error: `${row.request_type} requests have no separate approval step to decide here.` });
  } catch (e) { next(e); }
}

router.post('/:id/approve', requirePermission('approvals.view'), (req, res, next) => decide(req, res, next, { rejecting: false }));
router.post('/:id/reject', requirePermission('approvals.view'), (req, res, next) => decide(req, res, next, { rejecting: true }));

module.exports = router;
