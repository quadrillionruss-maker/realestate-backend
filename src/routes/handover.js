// routes/handover.js — the two top-level PATCH routes for SECTION 11.
// Creating a checklist and reading it are nested under
// routes/reservations.js (POST/GET /:id/handover); this file is the rest —
// updating a checklist, and acting on one buyer-reported snagging item.
const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const handover = require('../services/handoverService');
const router = express.Router();

router.patch('/snag/:id', requirePermission('handover.manage'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await handover.updateSnag(req, req.params.id, {
      status: body.status,
      developerResponse: body.developer_response,
      fixCommittedDate: body.fix_committed_date,
    });
    if (result.notFound) return res.status(404).json({ error: 'Snagging item not found' });
    res.json(result);
  } catch (e) { next(e); }
});

router.patch('/:id', requirePermission('handover.manage'), async (req, res, next) => {
  try {
    const result = await handover.updateChecklist(req, req.params.id, req.body || {});
    if (result.notFound) return res.status(404).json({ error: 'Handover checklist not found' });
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
