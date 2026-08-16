// auth.js — verifies the bearer token and populates req.user.
//
// Standalone: this service owns its authentication and imports nothing from
// any other codebase. It does not issue tokens — it verifies them — so a
// session minted by whatever service handles login is accepted here as long
// as both sides share JWT_SECRET.
//
// The contract it produces is what orgContext consumes:
//   req.user = { id, email, team_id, role }

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { supabaseAdmin } = require('./orgContext');
const { callerIp } = require('../services/auditService');

// SECTION 3 — session visibility. Hashed, never the raw token: this table
// is readable from GET /auth/sessions, and a token_hash is useless to
// anyone without the original bearer token, where the token itself would
// not be.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// A short "Browser on OS" string, parsed once at session creation and never
// re-parsed. Heuristic, not a real UA-parsing library — good enough for "is
// this the session on my phone or my laptop", which is the whole job.
function parseDeviceInfo(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Unknown device';

  let browser = 'Unknown browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Version\/.*Safari\//.test(ua) || /Safari\//.test(ua)) browser = 'Safari';

  let os = 'Unknown OS';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ success: false, error: 'Access denied. Malformed token.' });
  }

  let decoded;
  try {
    // Pin the algorithm. Without this, a token with alg:none — or RS256 using
    // a public key as the HMAC secret — would verify.
    decoded = jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token expired. Please log in again.' });
    }
    return res.status(401).json({ success: false, error: 'Invalid token.' });
  }

  // A portal link is signed with the same secret but carries aud:'re-portal'.
  // It must never be accepted as a staff session — that is the whole boundary
  // between "a buyer holding a forwarded link" and "an operator".
  if (decoded.aud) {
    return res.status(401).json({ success: false, error: 'This token is not valid for the operator API.' });
  }

  // `sub` is the standard JWT claim and what Supabase Auth issues; `id` is
  // what hand-rolled auth services commonly use. Accept either so this API
  // works with whichever one is put in front of it.
  const userId = decoded.id || decoded.sub;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Token is missing a subject.' });
  }

  // ── Session invalidation ───────────────────────────────────────────────
  // A verified signature only proves the token was issued by us; it says
  // nothing about whether the session should still exist. Without this check a
  // sales executive fired on Monday keeps full API access for the remaining 30
  // days of their token, from any machine, and changing their password does not
  // revoke it either.
  //
  // `tv` is compared against users.token_version (migrations/004). Bumping that
  // column kills every token ever issued to that user at once. A token minted
  // before 004 has no `tv` claim and is treated as 0, so deploying this does
  // not sign the whole company out.
  //
  // It costs one indexed primary-key read per request. If that ever matters,
  // cache it — do not remove it.
  let tokenVersionOk = true;
  let emailVerifiedAt = null;
  try {
    // email_verified_at rides along in the same read the session check already
    // needs, so gating on verification costs no extra round trip.
    const { data: account, error } = await supabaseAdmin
      .from('users')
      .select('token_version, email_verified_at')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      // 42703/42P01 = undefined column/table: a database that has not run
      // 004 yet. Fail OPEN only for that specific, known-safe case, because
      // the alternative is a deploy that locks every user out before anyone
      // can apply the migration that would fix it. Anything else — a
      // timeout, a dropped connection, an exhausted pool — is transient, not
      // a schema gap, and must fail CLOSED: this check exists to guarantee a
      // revoked session dies immediately, and failing open here defeats that
      // guarantee under exactly the load conditions it matters most.
      if (error.code === '42703' || error.code === '42P01') {
        console.warn('[auth] token_version unavailable, skipping session check:', error.message);
      } else {
        console.error('[auth] session check failed, refusing the request:', error.message);
        return res.status(503).json({ success: false, error: 'Could not verify this session. Try again shortly.' });
      }
    } else if (!account) {
      // The user was deleted. A signature from a deleted account is not a
      // session.
      return res.status(401).json({ success: false, error: 'This account no longer exists.' });
    } else {
      emailVerifiedAt = account.email_verified_at || null;
      if (Number(decoded.tv || 0) !== Number(account.token_version || 0)) {
        tokenVersionOk = false;
      }
    }
  } catch (err) {
    // Same transient category as a non-schema query error above — fail closed.
    console.error('[auth] session check threw, refusing the request:', err.message);
    return res.status(503).json({ success: false, error: 'Could not verify this session. Try again shortly.' });
  }

  if (!tokenVersionOk) {
    return res.status(401).json({
      success: false,
      error: 'This session has been ended. Please sign in again.',
    });
  }

  // ── Which workspace is this request in? ─────────────────────────────────
  // Team membership decides the org scope (team_id ?? user id — see
  // orgContext). Deployments without a team_members table are treated as
  // solo accounts rather than failing: this service must stand on its own.
  //
  // A person can now belong to more than one workspace, which changed the
  // shape of this lookup. It used to be `.maybeSingle()` — which does not
  // merely pick one of several rows, it ERRORS on more than one, so the first
  // time anybody was invited to a second team every request they made would
  // have failed. It is a list now, and the request picks from it.
  //
  // THE TOKEN STILL CARRIES NO ORG SCOPE, deliberately (see
  // authService.issueToken: id, email, tv, and nothing else). Putting a
  // workspace id in the JWT would mean a stale token keeps resolving to a
  // workspace somebody has been removed from until it expires, and it would
  // break the audience boundary the whole auth model rests on. So the choice
  // travels per request, in a header the browser sends, and is VALIDATED
  // against live membership here — a header naming a workspace this user is
  // not an active member of is ignored, not honoured.
  let teamId = null;
  let role = null;
  let memberships = [];
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('team_members')
      .select('team_id, role')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('joined_at', { ascending: true });

    if (error) {
      // Mirrors the token_version check above, exactly: 42703/42P01 =
      // undefined column/table, a deployment with no team_members table at
      // all, which this service must still run against as a solo account
      // (see CLAUDE.md's "Org scoping"). Anything else — a timeout, a
      // dropped connection, an exhausted pool — is transient, not a schema
      // gap, and must fail CLOSED: silently falling through to "solo
      // account" here sets teamId/role to null, which orgContext then reads
      // as req.orgId = user.id and req.orgRole = 'owner' — quietly demoting
      // a real team member to a solo-workspace owner on nothing more than a
      // hiccup, and (worse) handing them an owner-shaped view of a workspace
      // that is actually only their own.
      if (error.code === '42703' || error.code === '42P01') {
        console.warn('[auth] team_members table unavailable, treating as solo account:', error.message);
      } else {
        console.error('[auth] team lookup failed, refusing the request:', error.message);
        return res.status(503).json({ success: false, error: 'Could not verify this session. Try again shortly.' });
      }
    } else {
      memberships = rows || [];
    }
  } catch (err) {
    // Same transient category as a non-schema query error above — fail closed.
    console.error('[auth] team lookup threw, refusing the request:', err.message);
    return res.status(503).json({ success: false, error: 'Could not verify this session. Try again shortly.' });
  }

  if (memberships.length) {
    const requested = String(req.headers['x-workspace-id'] || '').trim();
    // Falls back to the OLDEST active membership rather than erroring. A
    // missing header is the normal case for any client that predates the
    // switcher, and a header naming a workspace they have left is the normal
    // case for a browser holding a stale selection — neither is worth a 400,
    // and both have an obviously correct answer.
    const chosen = (requested && memberships.find((m) => m.team_id === requested)) || memberships[0];
    teamId = chosen.team_id;
    role = chosen.role;
  }

  // SECTION 3 — session revocation. Checked BEFORE next() so a session
  // ended from another tab/device (DELETE /auth/sessions/:id) stops working
  // on its very next request, the same "a valid signature is not a live
  // session" guarantee token_version already gives every token this user
  // has ever held — this one just scopes to a single token instead of all
  // of them.
  const tokenHash = hashToken(token);
  try {
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('re_sessions')
      .select('revoked_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (sessionError) {
      // 42703/42P01 = migration 047 not yet applied — same fail-open shape
      // as the token_version/team_members checks above for exactly the
      // same reason: a database mid-deploy must not lock every user out.
      if (sessionError.code !== '42703' && sessionError.code !== '42P01') {
        console.error('[auth] session lookup failed, refusing the request:', sessionError.message);
        return res.status(503).json({ success: false, error: 'Could not verify this session. Try again shortly.' });
      }
    } else if (session?.revoked_at) {
      return res.status(401).json({ success: false, error: 'This session has been ended. Please sign in again.' });
    } else {
      // Fire-and-forget: never blocks the request, never fails it — a
      // dropped write here costs one stale last_used_at, not a 500 on
      // every single API call. device_info is only ever set on the INSERT
      // branch (a device does not change mid-session); ip_address and
      // last_used_at are refreshed every time regardless.
      const orgIdForSession = teamId || userId;
      supabaseAdmin
        .from('re_sessions')
        .upsert(
          {
            token_hash: tokenHash,
            user_id: userId,
            organization_id: orgIdForSession,
            device_info: parseDeviceInfo(req.headers['user-agent']),
            ip_address: callerIp(req),
            last_used_at: new Date().toISOString(),
          },
          { onConflict: 'token_hash', ignoreDuplicates: false }
        )
        .then(
          () => {},
          (err) => console.warn('[auth] could not record session activity:', err.message)
        );
    }
  } catch (err) {
    console.error('[auth] session check threw, refusing the request:', err.message);
    return res.status(503).json({ success: false, error: 'Could not verify this session. Try again shortly.' });
  }

  req.user = {
    id: userId,
    email: decoded.email || null,
    team_id: teamId,
    role,
    // Every workspace this person can switch into, resolved once here so
    // /auth/me can render the switcher without a second membership read.
    memberships,
    // Read by orgContext, which is what actually blocks the API for an
    // unverified address. Set here so there is one users lookup, not two.
    email_verified_at: emailVerifiedAt,
  };
  // SECTION 3 — so a route can identify (and revoke) THIS request's own
  // session without the client ever having to know or send its id — see
  // GET /auth/me's current_session_id and the sign-out flow that uses it.
  req.tokenHash = tokenHash;

  next();
}

module.exports = { authenticate };
