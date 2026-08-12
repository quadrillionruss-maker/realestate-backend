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
const { normalizeRole } = require('../services/permissions');

// Service-role client: bypasses RLS, so EVERY query in this service filters
// organization_id explicitly. RLS stays enabled as the second lock (see
// migrations/001). One client, shared — it is stateless.
//
// `supabaseRaw` sees everything, including soft-deleted rows. Almost nothing
// should use it: src/services/softDelete.js needs it to list and restore
// deleted rows, and that is the whole legitimate audience.
// supabase-js has no built-in request timeout — left alone, a stalled query
// hangs until Node's own TCP timeout, which can be minutes or effectively
// forever. This aborts and surfaces it as a normal rejection instead, so a
// hung database connection turns into a 500 rather than a request that never
// answers at all.
function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.supabase.timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const supabaseRaw = createClient(
  env.supabase.url,
  env.supabase.serviceRoleKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout },
  }
);

// ── Soft delete, enforced at the client rather than per query ──────────────
//
// Nothing in this product is really deleted (migrations/005): a delete stamps
// deleted_at and the row has to vanish from every read. That is one line —
// `.is('deleted_at', null)` — applied at about 150 query sites, and the
// hundred-and-fiftieth is the one somebody forgets. A single missed filter
// means a deleted buyer reappearing in a list, which is exactly the kind of
// bug that surfaces in front of a customer.
//
// So the filter is applied HERE, once, and it is not possible to forget it.
// `from(table).select(...)` on any soft-deletable table comes back already
// scoped to live rows.
//
// WHAT THIS DOES NOT TOUCH, deliberately:
//   * insert / update / delete — writes address rows by id, and the delete
//     path itself has to be able to write to a deleted row to restore it
//   * tables with no deleted_at (re_audit_log, re_notifications, users,
//     teams, re_org_settings) — passed straight through
//   * EMBEDDED resources. `re_reservations(re_customers(...))` filters the
//     reservations, not the nested customers. The cascade in softDelete.js is
//     what covers that: deleting a buyer deletes their reservations too, so a
//     live parent with a deleted child is not a state the app can reach. If a
//     future table breaks that assumption, filter it explicitly.
const SOFT_DELETABLE = new Set([
  're_projects', 're_units', 're_customers', 're_sales_reps', 're_reservations',
  're_installment_plans', 're_installment_schedule', 're_payments', 're_documents',
  're_tasks', 're_commissions', 're_payment_promises', 're_ai_briefs',
]);

const supabaseAdmin = Object.create(supabaseRaw);

supabaseAdmin.from = function scopedFrom(table) {
  const builder = supabaseRaw.from(table);
  if (!SOFT_DELETABLE.has(table)) return builder;

  const rawSelect = builder.select.bind(builder);
  builder.select = (...args) => rawSelect(...args).is('deleted_at', null);
  return builder;
};

// storage and the rest of the client surface are inherited from supabaseRaw
// through the prototype, so documentService and friends need no changes.
//
// UNFILTERED ESCAPE HATCHES: ONLY .from() is wrapped above. supabaseAdmin.rpc()
// and supabaseAdmin.schema() resolve straight through the prototype to
// supabaseRaw and see soft-deleted rows with no warning — the exact same
// unfiltered surface supabaseRaw itself is (see that comment above). A future
// caller reaching for supabaseAdmin.rpc(...) against a soft-deletable table,
// or supabaseAdmin.schema(...).from(...), gets no `deleted_at is null` for
// free and must apply it by hand, the same way any direct caller of
// supabaseRaw would have to.

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
  // read from team_members during authentication. normalizeRole is what keeps
  // that honest — a null (solo) reads as 'owner', and anything unrecognised
  // reads as the least-privileged role rather than being trusted.
  req.orgRole = normalizeRole(req.user.role);
  next();
}

// Role gating lives in src/middleware/rbac.js (requirePermission) and the
// rules it reads live in src/services/permissions.js. There is deliberately no
// requireRole(['owner','admin']) helper any more: a route naming its own role
// list is a second copy of the access model, and the second copy is the one
// that goes stale.

module.exports = { orgContext, resolveOrgId, supabaseAdmin, supabaseRaw, SOFT_DELETABLE };
