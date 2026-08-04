// routes/auth.js — the login flow. Mounted at /api/auth, OUTSIDE the
// `authenticate` middleware, because these are the endpoints you call when you
// do not yet have a token.
//
// It replaces the previous front door, which asked a property developer to
// paste a JWT minted from a terminal by someone else. `npm run token` still
// exists and still works — it is a debugging tool now rather than the only way
// in, exactly as CLAUDE.md said it would become "once a login service exists."
//
// The token this issues is the same HS256 token the rest of the API already
// accepts. src/middleware/auth.js did not change.

const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { authenticate } = require('../middleware/auth');
const { supabaseAdmin } = require('../middleware/orgContext');
const auth = require('../services/authService');
const invites = require('../services/inviteService');
const { ROLE_LABELS, actionsFor, normalizeRole } = require('../services/permissions');

const router = express.Router();

// Credential endpoints get their own budget. The global limiter (600 per 15
// minutes) is generous enough to be useless against password guessing.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Successful logins should not count towards a lockout: a busy office behind
  // one NAT would otherwise lock itself out by working normally.
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Too many attempts. Wait fifteen minutes and try again.' },
});

// What the sign-in screen needs to know before anyone types anything: whether
// to draw a Google button, and whether to offer a sign-up tab.
router.get('/config', (_req, res) => {
  res.json({
    google_client_id: env.auth.googleClientId || null,
    allow_registration: env.auth.allowRegistration,
    min_password_length: auth.MIN_PASSWORD_LENGTH,
  });
});

router.post('/register', credentialLimiter, async (req, res, next) => {
  try {
    const { email, password, full_name, company_name } = req.body || {};
    const result = await auth.register({ email, password, full_name, company_name });

    // A brand new account is a solo workspace (organization_id = user id), so
    // its settings row can be seeded now and the Settings screen is never empty.
    await supabaseAdmin
      .from('re_org_settings')
      .upsert({ organization_id: result.user.id, company_name: company_name || null },
              { onConflict: 'organization_id' });

    // Somebody invited before they had an account registers with that
    // address: any pending invites waiting on it become real membership in
    // this same request, so they land in the workspace(s) they were invited
    // to rather than an empty solo one. Never throws — see
    // inviteService.claimPendingInvites for why a failure here must not lose
    // the account.
    const joinedWorkspaces = await invites.claimPendingInvites({
      userId: result.user.id,
      email: result.user.email,
    });

    // No confirmation email — see authService.register. The account is
    // immediately usable; the browser signs in with the token below.
    res.status(201).json({ ...result, joined_workspaces: joinedWorkspaces });
  } catch (e) { next(e); }
});

router.post('/login', credentialLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    res.json(await auth.login({ email, password }));
  } catch (e) { next(e); }
});

// Google Identity Services runs in the browser and hands it an ID token; the
// browser posts that here. The token is verified against Google's published
// keys server-side — see authService.verifyGoogleIdToken.
router.post('/google', credentialLimiter, async (req, res, next) => {
  try {
    const credential = req.body?.credential || req.body?.id_token;
    const result = await auth.loginWithGoogle(credential);
    if (result.created) {
      await supabaseAdmin
        .from('re_org_settings')
        .upsert({ organization_id: result.user.id }, { onConflict: 'organization_id' });
    }
    res.json({ token: result.token, user: result.user });
  } catch (e) { next(e); }
});

// Disabled for now: this deployment's Resend account can only deliver to its
// own owner, so a self-service reset email would never reach an actual buyer
// or developer. No token is generated and nothing is emailed — the frontend
// shows this same message without ever calling the endpoint, but it answers
// identically if called directly, so there is no working path around it
// either. authService.requestPasswordReset/resetPassword are left intact
// (unused for now) to make turning this back on later a small change rather
// than a rebuild, once Resend is on a paid plan.
router.post('/forgot-password', credentialLimiter, (_req, res) => {
  res.json({ message: 'Please contact support to reset your password.' });
});

router.post('/reset-password', credentialLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    res.json(await auth.resetPassword({ token, password }));
  } catch (e) { next(e); }
});

// ── Invites ──────────────────────────────────────────────────────────────
// Preview is unauthenticated on purpose: somebody who clicks a link while
// signed out needs to see "Adron Homes invited you as a Sales Executive"
// BEFORE being asked to sign in or register — that is the one sentence that
// makes the next step make sense.
router.get('/invite/:token', credentialLimiter, async (req, res, next) => {
  try {
    const row = await invites.findByToken(req.params.token);
    res.json(invites.describeInvite(row));
  } catch (e) { next(e); }
});

// ── Authenticated ──────────────────────────────────────────────────────────
// `authenticate` is applied per-route rather than to the router, because
// everything above must remain reachable without a token.

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, company_name, avatar_url, created_at, last_login_at, email_verified_at')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });

    const role = normalizeRole(req.user.role);

    // Every workspace this person can switch into — the sidebar switcher's
    // whole data source, so it needs no call of its own. req.user.memberships
    // (set by middleware/auth.js) is empty for a solo account, in which case
    // there is nothing to switch between and the UI simply does not draw one.
    let workspaces = [];
    if (req.user.memberships?.length) {
      const teamIds = req.user.memberships.map((m) => m.team_id);
      const { data: teams } = await supabaseAdmin
        .from('teams').select('id, name').in('id', teamIds);
      const nameById = new Map((teams || []).map((t) => [t.id, t.name]));

      workspaces = req.user.memberships.map((m) => ({
        team_id: m.team_id,
        name: nameById.get(m.team_id) || 'Workspace',
        role: m.role,
        role_label: ROLE_LABELS[m.role] || m.role,
        is_current: m.team_id === req.user.team_id,
      }));
    }

    res.json({
      ...data,
      // The org scope the token resolves to, so the UI can label a team
      // workspace differently from a solo one without a second call.
      organization_id: req.user.team_id || req.user.id,
      is_team: Boolean(req.user.team_id),
      role,
      role_label: ROLE_LABELS[role] || role,
      // What THIS role may do, resolved once here so the browser draws the
      // same model the server enforces rather than a second copy of the
      // rules maintained by hand in screens.js.
      permissions: actionsFor(role),
      workspaces,
      // Informational only — nothing in the app gates on this any more.
      email_verified: Boolean(req.user.email_verified_at),
      // A password-less account signed up with Google and has nothing to
      // "change"; the Settings screen shows "Set a password" instead.
      has_password: Boolean((await auth.findUserByEmail(data.email))?.password_hash),
    });
  } catch (e) { next(e); }
});

// Accepting an invite requires an account — a not-yet-registered invitee is
// routed to register first (frontend), and registration itself claims any
// pending invite for that address (see POST /register above). This route
// covers the rest: somebody who already has an account, signed in, clicking
// the link. The invite's own email is deliberately NOT required to match the
// signed-in account — see inviteService.acceptInvite for why.
router.post('/invite/accept', authenticate, async (req, res, next) => {
  try {
    const result = await invites.acceptInvite({
      token: req.body?.token,
      userId: req.user.id,
      userEmail: req.user.email,
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.patch('/me', authenticate, async (req, res, next) => {
  try {
    const { full_name, company_name, password, current_password } = req.body || {};
    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name || null;
    if (company_name !== undefined) updates.company_name = company_name || null;

    if (password !== undefined) {
      const existing = await auth.findUserByEmail(req.user.email || '');
      // Changing a password requires proving you know the current one, so a
      // borrowed laptop with an open session cannot lock the owner out. An
      // account with no password yet (Google sign-up) is setting one, not
      // changing one, and has nothing to prove.
      if (existing?.password_hash) {
        if (!current_password) {
          return res.status(400).json({ error: 'Enter your current password to change it.' });
        }
        if (!(await auth.verifyPassword(current_password, existing.password_hash))) {
          return res.status(401).json({ error: 'Current password is incorrect.' });
        }
      }
      if (String(password).length < auth.MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${auth.MIN_PASSWORD_LENGTH} characters.` });
      }
      updates.password_hash = await auth.hashPassword(password);
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select('id, email, full_name, company_name, avatar_url')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });

    // Changing a password ends every other session. Somebody who changes theirs
    // because they think a device is compromised expects exactly that, and
    // without it the old token keeps working for the rest of its 30 days.
    //
    // A fresh token is returned so the caller stays signed in — they are the
    // one who asked for this. The browser swaps it in silently.
    if (updates.password_hash) {
      const version = await auth.bumpTokenVersion(req.user.id);
      return res.json({
        ...data,
        token: auth.issueToken({ ...data, token_version: version ?? 0 }),
        sessions_ended: true,
      });
    }

    res.json(data);
  } catch (e) { next(e); }
});

// "Sign out" in the browser only ever cleared localStorage — the token
// itself kept working for the rest of its 30 days if it had been copied
// anywhere else (a stolen laptop, a shared machine, a support ticket pasting
// a header). This is the lightweight "end my other sessions" the product
// otherwise only offered via a full password change. Bumping token_version
// ends every session including this one, so a fresh token is returned in the
// same response — the caller asked to sign out of everywhere ELSE, not to be
// immediately logged out of the request they just made.
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    const version = await auth.bumpTokenVersion(req.user.id);
    res.json({
      token: auth.issueToken({ id: req.user.id, email: req.user.email, token_version: version ?? 0 }),
      sessions_ended: true,
    });
  } catch (e) { next(e); }
});

module.exports = router;
