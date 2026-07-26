// orgContext.js — the module's single point of contact with FlowDesk auth.
//
// FlowDesk's src/middleware/auth.js verifies its own HS256 JWT and sets:
//   req.user = { id, email, default_currency, team_id, role }
// with team_id === null for solo (non-team) accounts.
//
// This middleware turns that into the org scope every route below uses.
// It never verifies tokens itself — mount FlowDesk's `authenticate` in
// front of it (see src/app.js) so there is exactly one auth implementation.

const { createClient } = require('@supabase/supabase-js');

// Service-role client: bypasses RLS, so EVERY query in this module filters
// organization_id explicitly. RLS stays enabled as the second lock (see
// migrations/001). Its own instance rather than FlowDesk's so the module
// stays copy-pasteable; the client is stateless and cheap.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// The scope key, identical to FlowDesk's src/utils/scopeOwner.js rule:
// a team workspace is scoped by team, a solo account by the user.
// Keep these two definitions in step — if FlowDesk changes how it scopes
// ownership, this is the one line here that must follow.
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
  // FlowDesk's auth middleware read from team_members.
  req.orgRole = req.user.role || 'owner';
  next();
}

module.exports = { orgContext, resolveOrgId, supabaseAdmin };
