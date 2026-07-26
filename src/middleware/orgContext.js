// orgContext.js — turns an authenticated user into an org scope.
//
// src/middleware/auth.js verifies the token and sets:
//   req.user = { id, email, team_id, role }
// with team_id === null for solo (non-team) accounts. This middleware runs
// after it and produces req.orgId, which every query in this service filters
// on. It never verifies tokens itself, so there is exactly one place that
// decides who a caller is.

const { createClient } = require('@supabase/supabase-js');
const env = require('../config/env'); // also loads .env for everything downstream

// Service-role client: bypasses RLS, so EVERY query in this service filters
// organization_id explicitly. RLS stays enabled as the second lock (see
// migrations/001). One client, shared — it is stateless.
const supabaseAdmin = createClient(
  env.supabase.url,
  env.supabase.serviceRoleKey,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// The scope key: a team workspace is scoped by team, a solo account by the
// user. Every table carries organization_id set from this, which is why one
// `.eq('organization_id', req.orgId)` is enough to isolate a tenant.
function resolveOrgId(user) {
  if (!user || !user.id) return null;
  return user.team_id || user.id;
}

function orgContext(req, res, next) {
  const orgId = resolveOrgId(req.user);
  if (!orgId) {
    return res.status(401).json({ success: false, error: 'Not authenticated.' });
  }
  req.orgId = orgId;
  req.userId = req.user.id;
  // Solo accounts own their workspace outright; team accounts carry the role
  // read from team_members during authentication.
  req.orgRole = req.user.role || 'owner';
  next();
}

module.exports = { orgContext, resolveOrgId, supabaseAdmin };
