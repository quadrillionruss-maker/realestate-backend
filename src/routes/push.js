// routes/push.js — SECTION 1. A subscription is personal to the caller, not
// a workspace setting, so every route here needs only authentication (no
// requirePermission) — anyone who can sign in may subscribe their own
// browser to their own workspace's pushes.

const express = require('express');
const pushService = require('../services/pushService');
const router = express.Router();

router.post('/subscribe', async (req, res, next) => {
  try {
    const data = await pushService.subscribe(req.userId, req.orgId, req.body?.subscription);
    res.status(201).json({ id: data.id });
  } catch (e) { next(e); }
});

// Body, not a param — a PushSubscription's endpoint is a long opaque URL,
// not something to URL-encode into a path.
router.delete('/unsubscribe', async (req, res, next) => {
  try {
    await pushService.unsubscribe(req.orgId, req.body?.endpoint);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/test', async (req, res, next) => {
  try {
    if (!pushService.configured()) {
      return res.status(503).json({ error: 'Push notifications are not configured on this server (VAPID keys missing).' });
    }
    const result = await pushService.notify(req.orgId, [req.userId], {
      title: 'Test notification',
      body: 'If you can see this, push notifications are working.',
    });
    res.json(result);
  } catch (e) { next(e); }
});

// ── The bell ─────────────────────────────────────────────────────────────
// Always the CALLER's own notifications (req.userId) — there is no
// "everyone's notifications" view; a collections officer does not see the
// owner's payment alerts just because they share a workspace.
router.get('/notifications', async (req, res, next) => {
  try {
    const result = await pushService.listNotifications(req.orgId, req.userId, {
      limit: Number(req.query.limit) || 20,
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/notifications/:id/read', async (req, res, next) => {
  try {
    await pushService.markRead(req.orgId, req.userId, req.params.id);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/notifications/read-all', async (req, res, next) => {
  try {
    await pushService.markAllRead(req.orgId, req.userId);
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
