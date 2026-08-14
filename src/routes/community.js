// routes/community.js — the staff side of the buyer community forum,
// SECTION 13. Posting itself only ever happens from the buyer portal
// (routes/portal.js) — see communityService.js for why there is no staff
// authorship at all, only moderation.
const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const community = require('../services/communityService');
const router = express.Router();

router.get('/:projectId', requirePermission('community.moderate'), async (req, res, next) => {
  try {
    res.json(await community.listPostsForStaff(req.orgId, req.params.projectId));
  } catch (e) { next(e); }
});

router.delete('/post/:postId', requirePermission('community.moderate'), async (req, res, next) => {
  try {
    const result = await community.moderateDelete(req, req.params.postId);
    if (result.notFound) return res.status(404).json({ error: 'Post not found' });
    res.json(result);
  } catch (e) { next(e); }
});

router.patch('/post/:postId/pin', requirePermission('community.moderate'), async (req, res, next) => {
  try {
    const result = await community.setPinned(req, req.params.postId, req.body?.pinned !== false);
    if (result.notFound) return res.status(404).json({ error: 'Post not found' });
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
