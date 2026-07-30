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
const notify = require('../services/notificationService');

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
    // The sign-up form tells people to expect an email only when one is
    // actually going to be sent.
    require_email_verification: env.auth.requireEmailVerification,
  });
});

// Sends (or re-sends) the confirmation link. Shared by registration and by the
// "didn't get it?" button on the verify screen, so there is one place that
// decides what that email says.
async function sendVerificationEmail(user) {
  const link = await auth.issueVerificationToken(user.id);

  const result = await notify.sendEmail({
    orgId: user.id,
    to: user.email,
    subject: 'Confirm your email address',
    html: notify.emailShell({
      heading: 'Confirm your email address',
      intro: `Click below to confirm ${user.email} and start using Realtika. The link expires in ${env.auth.verifyTokenTtlHours} hours.`,
      ctaLabel: 'Confirm my email',
      ctaUrl: link.url,
      footer: 'If you did not create a Realtika account, ignore this email — nothing will happen.',
    }),
    text: `Confirm your email address: ${link.url}`,
    template: 'email_verification',
  });

  // Returned only outside production and only when email is unconfigured, so
  // the flow stays testable locally without a Resend key.
  return {
    status: result.status,
    dev_url: env.isDev && !env.resend.apiKey ? link.url : undefined,
  };
}

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

    // The account exists either way. If the email fails to send they can ask
    // for another from the verify screen — failing the registration over an
    // unreachable mail provider would lose the account entirely.
    let verification = null;
    if (!result.email_verified) {
      verification = await sendVerificationEmail(result.user).catch((err) => {
        console.warn('[auth] verification email failed:', err.message);
        return { status: 'failed' };
      });
    }

    res.status(201).json({ ...result, verification });
  } catch (e) { next(e); }
});

// Confirms the address and signs them in — a second trip through the login form
// immediately after proving they own the email is friction for nothing.
router.post('/verify-email', credentialLimiter, async (req, res, next) => {
  try {
    res.json(await auth.verifyEmail(req.body?.token));
  } catch (e) { next(e); }
});

// "Didn't get the email?" Requires a valid token, so it can only ever resend to
// the address on the caller's own account — otherwise it would be a way to have
// this server mail an arbitrary stranger on demand.
router.post('/resend-verification', credentialLimiter, authenticate, async (req, res, next) => {
  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, email, email_verified_at')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.email_verified_at) {
      return res.json({ already_verified: true, message: 'That address is already confirmed.' });
    }

    const verification = await sendVerificationEmail(user);
    res.json({
      message: `A new confirmation link is on its way to ${user.email}.`,
      ...verification,
    });
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

// Always answers the same way. Whether an address has an account here is not
// something a form should be willing to confirm to a stranger.
router.post('/forgot-password', credentialLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const result = await auth.requestPasswordReset(email);

    if (result.sent) {
      const html = notify.emailShell({
        heading: 'Reset your password',
        intro: `Someone asked to reset the password for ${result.user.email}. This link works once and expires in ${env.auth.resetTokenTtlMinutes} minutes.`,
        ctaLabel: 'Choose a new password',
        ctaUrl: result.resetUrl,
        footer: 'If this was not you, ignore this email — your password has not changed.',
      });

      await notify.sendEmail({
        orgId: result.user.id,
        to: result.user.email,
        subject: 'Reset your Realtika password',
        html,
        text: `Reset your password: ${result.resetUrl}`,
        template: 'password_reset',
      });
    }

    const response = {
      message: 'If an account exists for that address, a reset link is on its way.',
    };

    // Without Resend configured the email is recorded as 'skipped' and nobody
    // receives anything, which would make this endpoint quietly useless. In
    // development the link is returned directly so the flow is still testable;
    // in production it never is.
    if (env.isDev && result.sent && !env.resend.apiKey) {
      response.dev_reset_url = result.resetUrl;
      response.note = 'RESEND_API_KEY is not set, so no email was sent. This field only appears outside production.';
    }

    res.json(response);
  } catch (e) { next(e); }
});

router.post('/reset-password', credentialLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    res.json(await auth.resetPassword({ token, password }));
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

    res.json({
      ...data,
      // The org scope the token resolves to, so the UI can label a team
      // workspace differently from a solo one without a second call.
      organization_id: req.user.team_id || req.user.id,
      is_team: Boolean(req.user.team_id),
      role: req.user.role || 'owner',
      // /auth/me deliberately works for an UNVERIFIED user — it is the endpoint
      // the app calls to discover that it should show the verify screen.
      email_verified: Boolean(req.user.email_verified_at),
      verification_required: env.auth.requireEmailVerification,
      // A password-less account signed up with Google and has nothing to
      // "change"; the Settings screen shows "Set a password" instead.
      has_password: Boolean((await auth.findUserByEmail(data.email))?.password_hash),
    });
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

module.exports = router;
