// auth.js — verifies the bearer token and populates req.user.
//
// Standalone: this service owns its authentication and imports nothing from
// any other codebase. It does not issue tokens — it verifies them — so a
// session minted by whatever service handles login is accepted here as long
// as both sides share JWT_SECRET.
//
// The contract it produces is what orgContext consumes:
//   req.user = { id, email, team_id, role }

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { supabaseAdmin } = require('./orgContext');

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
      // Column or table missing (a database that has not run 004): fail OPEN,
      // because the alternative is a deploy that locks every user out. Loud in
      // the log so it is fixed rather than lived with.
      console.warn('[auth] token_version unavailable, skipping session check:', error.message);
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
    console.warn('[auth] session check threw, allowing request:', err.message);
  }

  if (!tokenVersionOk) {
    return res.status(401).json({
      success: false,
      error: 'This session has been ended. Please sign in again.',
    });
  }

  // Team membership decides the org scope (team_id ?? user id — see
  // orgContext). Deployments without a team_members table are treated as
  // solo accounts rather than failing: this service must stand on its own.
  let teamId = null;
  let role = null;
  try {
    const { data: member, error } = await supabaseAdmin
      .from('team_members')
      .select('team_id, role')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      console.warn('[auth] team lookup failed, treating as solo account:', error.message);
    } else if (member) {
      teamId = member.team_id;
      role = member.role;
    }
  } catch (err) {
    console.warn('[auth] team lookup threw, treating as solo account:', err.message);
  }

  req.user = {
    id: userId,
    email: decoded.email || null,
    team_id: teamId,
    role,
    // Read by orgContext, which is what actually blocks the API for an
    // unverified address. Set here so there is one users lookup, not two.
    email_verified_at: emailVerifiedAt,
  };

  next();
}

module.exports = { authenticate };
