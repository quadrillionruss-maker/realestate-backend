// rbac.js — the Express half of the permission model.
//
// src/services/permissions.js holds the rules and knows nothing about HTTP.
// This file is the thin adapter: it reads req.orgRole (set by orgContext) and
// turns a `false` into a 403 with a sentence somebody can act on.
//
// It also owns the two ROW-level scopes, because both need a database read
// and both are asked for on nearly every request a sales rep makes:
//
//   salesRepIdsFor(req)  which re_sales_reps rows are this user
//   scopeReservations()  the .in() that follows from it
//
// ── WHY re_sales_reps AND NOT users ────────────────────────────────────────
// "A sales rep's own reservations" is the single most consequential detail in
// this whole model, and the obvious reading of it is wrong.
// re_reservations.sales_rep_id and re_commissions.sales_rep_id reference
// re_sales_reps(id) — NOT users(id). re_sales_reps is its own table with its
// own id and a user_id pointing at the person. So filtering
// `sales_rep_id = req.userId` matches nothing at all, and a rep would see an
// empty product; filtering nothing would show them the whole company's book.
// The correct filter is two steps: find the re_sales_reps rows for this user
// in this org, then filter by `sales_rep_id in (those ids)`.
//
// Matched on user_id, not on email. The existing workload/reassign code in
// routes/settings.js matches reps to people by email address, which breaks
// silently the first time somebody changes theirs — a rep would keep their
// reservations and lose their identity, or worse, inherit somebody else's.

const { canAccess, denialMessage, normalizeRole } = require('../services/permissions');
const { supabaseAdmin } = require('./orgContext');

// requirePermission('payments.waive') — mounted per route, after orgContext.
function requirePermission(action) {
  return function (req, res, next) {
    if (!canAccess(req.orgRole, action)) {
      return res.status(403).json({
        success: false,
        code: 'forbidden',
        error: denialMessage(req.orgRole, action),
      });
    }
    next();
  };
}

// The same check inside a handler, for the routes that branch on the request
// body rather than the path — PATCH /commissions/status is 'approved' for a
// sales director and 'paid' for the owner alone, and that cannot be a
// middleware because it depends on what was posted.
function assertPermission(req, res, action) {
  if (canAccess(req.orgRole, action)) return true;
  res.status(403).json({
    success: false,
    code: 'forbidden',
    error: denialMessage(req.orgRole, action),
  });
  return false;
}

// Which re_sales_reps rows are this caller, in this org. Cached on the request
// because a single handler can need it three times (list, count, filter) and
// it never changes mid-request.
//
// Returns [] for somebody who has never been tagged as a rep — which is a real
// and correct state, not an error: a sales executive invited this morning has
// a team_members row and no re_sales_reps row until an owner adds them. They
// see nothing rather than everything, which is the safe direction.
async function salesRepIdsFor(req) {
  if (req._salesRepIds) return req._salesRepIds;

  let ids = [];
  try {
    const { data, error } = await supabaseAdmin
      .from('re_sales_reps')
      .select('id')
      .eq('organization_id', req.orgId)
      .eq('user_id', req.userId);
    if (error) throw error;
    ids = (data || []).map((row) => row.id);
  } catch (err) {
    // Log the message only, never the raw driver error — see CLAUDE.md on
    // .detail/.hint quoting row values into Render's log retention.
    console.warn('[rbac] could not resolve sales rep identity:', err.message);
  }

  req._salesRepIds = ids;
  return ids;
}

// True when this role only ever sees rows it owns. Everything else in the
// product reads "can they open this screen"; this reads "how much of it".
function isOwnRecordsOnly(role) {
  return normalizeRole(role) === 'sales_rep';
}

// A uuid that cannot match anything, used to make an `.in()` return zero rows
// rather than being dropped. Supabase's `.in('col', [])` is not reliably an
// empty result across versions, and "the filter silently did nothing" on a
// permission filter is the worst possible failure mode.
const MATCHES_NOTHING = '00000000-0000-0000-0000-000000000000';

module.exports = {
  requirePermission,
  assertPermission,
  salesRepIdsFor,
  isOwnRecordsOnly,
  MATCHES_NOTHING,
};
