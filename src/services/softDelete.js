// softDelete.js — nothing in this product is ever really deleted.
//
// A developer who removes a buyer who has paid ₦15m across eighteen months must
// not be one click away from losing that, and in a dispute "we deleted it" is
// not an answer anybody wants to give a lawyer. So a delete stamps deleted_at,
// the row leaves every read the application makes, and it stays in the database
// and in the audit log permanently.
//
// ── THE RULE EVERY READ FOLLOWS ────────────────────────────────────────────
//   .is('deleted_at', null)
//
// It is one line, it is easy to forget, and forgetting it means deleted buyers
// reappearing in a list. `live()` exists so the filter has a name worth reading
// and so a grep for it finds every place that reads domain data.
//
// ── WHAT CANNOT BE DELETED, AND WHY ────────────────────────────────────────
// re_audit_log and re_notifications have no deleted_at column at all. They are
// records of what happened and what was sent; a nullable deleted_at on either
// would imply the evidence can be withdrawn, which is the opposite of why they
// exist. Nothing here can touch them.
//
// ── CASCADES ───────────────────────────────────────────────────────────────
// Postgres FK cascades are on the HARD delete path, which nothing uses any
// more, so a soft delete cascades through the CHILDREN map below instead. It is
// explicit on purpose: deleting a buyer should take their reservations with
// them, and deleting a project should not silently erase a year of payments
// without saying how many rows it touched.

// supabaseRaw, not supabaseAdmin: this module is the one place that has to SEE
// deleted rows. supabaseAdmin auto-filters them out (see orgContext), which
// would make listDeleted return nothing and restore find nothing.
const { supabaseRaw: supabaseAdmin } = require('../middleware/orgContext');
const { audit } = require('./auditService');

// Every table that carries deleted_at. Anything not here has no soft-delete
// concept and cannot be reached through this module.
const DELETABLE = new Set([
  're_projects', 're_units', 're_customers', 're_sales_reps', 're_reservations',
  're_installment_plans', 're_installment_schedule', 're_payments', 're_documents',
  're_tasks', 're_commissions', 're_payment_promises', 're_ai_briefs',
]);

// What a delete takes with it, and the column that links child to parent.
// Depth-first, so the deepest rows are stamped before the row they hang off —
// which means a failure part-way through leaves children deleted under a live
// parent (recoverable and visible) rather than a live child under a deleted
// parent (invisible and orphaned).
const CHILDREN = {
  re_projects: [['re_units', 'project_id']],
  re_units: [['re_reservations', 'unit_id']],
  re_customers: [['re_reservations', 'customer_id'], ['re_payment_promises', 'customer_id']],
  re_reservations: [
    ['re_installment_plans', 'reservation_id'],
    ['re_documents', 'reservation_id'],
    ['re_commissions', 'reservation_id'],
    ['re_tasks', 'related_reservation_id'],
  ],
  re_installment_plans: [['re_installment_schedule', 'plan_id']],
  re_installment_schedule: [['re_payments', 'schedule_id'], ['re_payment_promises', 'schedule_id']],
  re_payments: [['re_commissions', 'payment_id']],
};

// Applies the live filter. Use it on every read of a deletable table:
//   live(supabaseAdmin.from('re_customers').select('*')).eq('organization_id', orgId)
const live = (query) => query.is('deleted_at', null);

// ── Delete ─────────────────────────────────────────────────────────────────
// Returns { deleted: { table: count } }, so the caller can tell the operator
// what actually happened rather than "done".
async function softDelete(req, table, id, { reason = null } = {}) {
  if (!DELETABLE.has(table)) {
    throw Object.assign(new Error(`${table} cannot be deleted.`), { statusCode: 400 });
  }

  const { data: row, error: findError } = await supabaseAdmin
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('organization_id', req.orgId)
    .is('deleted_at', null)
    .maybeSingle();
  if (findError) throw findError;
  if (!row) return { notFound: true };

  const stamp = { deleted_at: new Date().toISOString(), deleted_by: req.userId || null };
  const deleted = {};

  await cascade(table, [id], req.orgId, stamp, deleted);

  const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);

  audit(req, {
    action: `${table.replace(/^re_/, '')}.deleted`,
    entityType: table,
    entityId: id,
    summary: `Soft-deleted 1 ${table.replace(/^re_/, '').replace(/s$/, '')} and ${total - 1} related record(s)`
      + (reason ? ` — ${reason}` : ''),
    metadata: { deleted, reason, recoverable: true },
  });

  return { deleted, total };
}

async function cascade(table, ids, orgId, stamp, tally) {
  if (!ids.length) return;

  // Children first, so nothing is ever live underneath a deleted parent.
  for (const [childTable, foreignKey] of CHILDREN[table] || []) {
    const { data: children } = await supabaseAdmin
      .from(childTable)
      .select('id')
      .in(foreignKey, ids)
      .eq('organization_id', orgId)
      .is('deleted_at', null);

    await cascade(childTable, (children || []).map((c) => c.id), orgId, stamp, tally);
  }

  const { data, error } = await supabaseAdmin
    .from(table)
    .update(stamp)
    .in('id', ids)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .select('id');
  if (error) throw error;

  tally[table] = (tally[table] || 0) + (data?.length || 0);
}

// ── Restore ────────────────────────────────────────────────────────────────
// The reason soft delete is worth having. Restores the row and everything that
// went down with it, matched on the same deleted_at instant — so restoring a
// buyer does not resurrect a reservation that had been deleted separately a
// month earlier.
async function restore(req, table, id) {
  if (!DELETABLE.has(table)) {
    throw Object.assign(new Error(`${table} cannot be restored.`), { statusCode: 400 });
  }

  const { data: row } = await supabaseAdmin
    .from(table)
    .select('id, deleted_at')
    .eq('id', id)
    .eq('organization_id', req.orgId)
    .not('deleted_at', 'is', null)
    .maybeSingle();

  if (!row) return { notFound: true };

  const restored = {};
  await uncascade(table, [id], req.orgId, row.deleted_at, restored);

  audit(req, {
    action: `${table.replace(/^re_/, '')}.restored`,
    entityType: table,
    entityId: id,
    summary: `Restored from deletion, with ${Object.values(restored).reduce((s, n) => s + n, 0) - 1} related record(s)`,
    metadata: { restored, deleted_at: row.deleted_at },
  });

  return { restored };
}

async function uncascade(table, ids, orgId, deletedAt, tally) {
  if (!ids.length) return;

  const { data, error } = await supabaseAdmin
    .from(table)
    .update({ deleted_at: null, deleted_by: null })
    .in('id', ids)
    .eq('organization_id', orgId)
    .eq('deleted_at', deletedAt)
    .select('id');
  if (error) throw error;

  tally[table] = (tally[table] || 0) + (data?.length || 0);

  for (const [childTable, foreignKey] of CHILDREN[table] || []) {
    const { data: children } = await supabaseAdmin
      .from(childTable)
      .select('id')
      .in(foreignKey, ids)
      .eq('organization_id', orgId)
      .eq('deleted_at', deletedAt);

    await uncascade(childTable, (children || []).map((c) => c.id), orgId, deletedAt, tally);
  }
}

// ── The bin ────────────────────────────────────────────────────────────────
// Recently deleted rows, so "restore" is something an operator can find
// unaided rather than a support request.
async function listDeleted(orgId, table, limit = 100) {
  if (!DELETABLE.has(table)) {
    throw Object.assign(new Error(`${table} has no deleted rows to list.`), { statusCode: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from(table)
    .select('*')
    .eq('organization_id', orgId)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
    .limit(Math.min(limit, 300));
  if (error) throw error;
  return data || [];
}

module.exports = { live, softDelete, restore, listDeleted, DELETABLE, CHILDREN };
