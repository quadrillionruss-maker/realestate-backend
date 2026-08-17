// routes/admin.js — the platform operator's view across every workspace.
//
// NOT mounted under routes/index.js: that router applies orgContext, whose
// entire job is picking ONE organization_id to filter every query by. Every
// route here does the opposite on purpose — no org filter, all of them. So
// this file is mounted directly in server.js, before authenticate/orgContext
// ever run, gated by its own middleware instead (adminAuth, below).
//
// Thin HTTP layer only — every query lives in adminService.js, same
// convention as the rest of this codebase.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const adminService = require('../services/adminService');
const onboarding = require('../services/onboardingService');
const clientErrors = require('../services/clientErrorService');

const router = express.Router();

// ── Auth ─────────────────────────────────────────────────────────────────
// Ten wrong secrets in fifteen minutes from one IP is already generous for a
// value nobody should ever be guessing at — this is a single shared secret
// with access to every workspace on the platform, not a per-account password
// with its own lockout. Independent of the global 600/15min limiter in
// server.js, which is sized for ordinary API traffic, not a credential this
// sensitive.
//
// TASK 3 AUDIT FIX (Important #9) — this budget used to apply to EVERY
// request, authenticated or not: loading Overview → Workspaces → Users →
// Health alone burned 4+ of the 10 slots, and a real admin browsing their
// own dashboard could 429 themselves out of it mid-investigation.
// skipSuccessfulRequests only counts requests that did NOT get a 2xx — a
// correctly authenticated call (every normal click) costs nothing against
// this budget; only a wrong secret (401) does, which is exactly what needs
// throttling.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Too many attempts. Wait a few minutes and try again.' },
});

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual throws on mismatched length rather than just returning
  // false — padding both to the longer length keeps the comparison itself
  // constant-time instead of leaking length via an early throw/return.
  const len = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(len); bufA.copy(padA);
  const padB = Buffer.alloc(len); bufB.copy(padB);
  return bufA.length === bufB.length && crypto.timingSafeEqual(padA, padB);
}

// TASK 3 AUDIT FIX (Important #10) — a weak-but-present secret used to be
// silently usable; this makes it behave exactly like an absent one. See
// env.js's own comment on env.adminSecretIsWeak for why boot itself isn't
// blocked over it.
function adminFeatureUnavailable(res) {
  res.status(503).json({ success: false, error: 'Admin dashboard is not configured on this server.' });
}

function adminAuth(req, res, next) {
  if (!env.adminSecret || env.adminSecretIsWeak) {
    return adminFeatureUnavailable(res);
  }

  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token || !timingSafeStringEqual(token, env.adminSecret)) {
    return res.status(401).json({ success: false, error: 'Invalid admin credentials.' });
  }
  next();
}

// A dedicated login endpoint so the frontend's password field has something
// to POST to and get a clean 200/401 from, rather than probing a random GET
// route to test the secret it was just handed. Applied BEFORE adminAuth (it
// IS the auth check) but still behind authLimiter.
router.post('/login', authLimiter, (req, res) => {
  if (!env.adminSecret || env.adminSecretIsWeak) {
    return adminFeatureUnavailable(res);
  }
  const { secret } = req.body || {};
  if (!secret || !timingSafeStringEqual(secret, env.adminSecret)) {
    return res.status(401).json({ success: false, error: 'Incorrect secret.' });
  }
  res.json({ success: true });
});

router.use(authLimiter, adminAuth);

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get('/overview', wrap(async (req, res) => {
  res.json(await adminService.overview());
}));

router.get('/workspaces', wrap(async (req, res) => {
  res.json(await adminService.listWorkspaces());
}));

router.get('/users', wrap(async (req, res) => {
  res.json(await adminService.listUsers());
}));

router.post('/users/:id/reset-password', wrap(async (req, res) => {
  res.json(await adminService.resetUserPassword(req.params.id));
}));

router.delete('/users/:id', wrap(async (req, res) => {
  res.json(await adminService.hardDeleteUser(req.params.id));
}));

router.post('/workspaces/:id/impersonate', wrap(async (req, res) => {
  res.json(await adminService.impersonateWorkspace(req.params.id));
}));

router.get('/agents', wrap(async (req, res) => {
  const { org, agent, outcome } = req.query;
  res.json(await adminService.agentActionsLog({ orgId: org || null, agentName: agent || null, outcome: outcome || null }));
}));

router.get('/notifications', wrap(async (req, res) => {
  res.json(await adminService.notificationStats());
}));

router.get('/health', wrap(async (req, res) => {
  res.json(await adminService.health());
}));

router.get('/migrations', wrap(async (req, res) => {
  res.json(await adminService.migrationStatus());
}));

router.get('/revenue', wrap(async (req, res) => {
  res.json(await adminService.revenue());
}));

router.get('/feature-usage', wrap(async (req, res) => {
  res.json(await adminService.featureUsage());
}));

router.get('/workspaces/:id/onboarding', wrap(async (req, res) => {
  res.json(await onboarding.checklist(req.params.id));
}));

router.get('/client-errors', wrap(async (req, res) => {
  res.json(await clientErrors.list());
}));

// The admin dashboard reporting ITS OWN bugs, same as the operator app does
// (routes/clientErrors.js) — a different route because there is no staff
// JWT / org context here to attach (adminAuth is a single shared secret,
// not a session), so orgId/userId are simply omitted; migrations/054 makes
// both columns nullable for exactly this case.
router.post('/client-errors', wrap(async (req, res) => {
  const { message, stack, screen, url, user_agent } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  await clientErrors.report({ app: 'admin', message, stack, screen, url, userAgent: user_agent });
  res.status(201).json({ reported: true });
}));

router.post('/client-errors/resolve', wrap(async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
  await clientErrors.resolve(ids);
  res.json({ resolved: ids.length });
}));

module.exports = router;
