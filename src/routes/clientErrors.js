// routes/clientErrors.js — where the operator app reports a bug in itself.
//
// No RBAC permission gate: every role may report a screen that broke for
// them — this is diagnostic telemetry about the app, not an action against
// workspace data, and gating it would just mean the roles most likely to
// hit an edge case (collections, documentation) are the ones whose bugs
// never reach anyone.

const express = require('express');
const rateLimit = require('express-rate-limit');
const clientErrors = require('../services/clientErrorService');

const router = express.Router();

// A genuinely broken screen can re-render (and re-throw) on every retry
// click or route change — bounded so that doesn't turn into a flood, not
// because a real user is expected to ever get near this.
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  message: { error: 'Too many error reports.' },
});

router.post('/', reportLimiter, async (req, res, next) => {
  try {
    const { message, stack, screen, url, user_agent } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });

    await clientErrors.report({
      orgId: req.orgId,
      userId: req.userId,
      app: 'operator',
      message, stack, screen, url, userAgent: user_agent,
    });
    res.status(201).json({ reported: true });
  } catch (e) { next(e); }
});

module.exports = router;
