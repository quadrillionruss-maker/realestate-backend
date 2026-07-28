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

  // `sub` is the standard JWT claim and what Supabase Auth issues; `id` is
  // what hand-rolled auth services commonly use. Accept either so this API
  // works with whichever one is put in front of it.
  const userId = decoded.id || decoded.sub;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Token is missing a subject.' });
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
  };

  next();
}

module.exports = { authenticate };
