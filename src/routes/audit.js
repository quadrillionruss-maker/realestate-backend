// routes/audit.js — reading the record. There is no route that writes it from
// a client, and no route that edits or deletes it at all: a log the operator
// can alter is not evidence, and evidence is the point (see auditService).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const { canAccess } = require('../services/permissions');
const { toCsv } = require('../utils/csv');
const { audit } = require('../services/auditService');
const router = express.Router();

// FEATURE — a full CSV of the audit log is the single most sensitive export
// this product offers (every action, every actor, every IP, back to day
// one); owner-only (see permissions.js) and rate-limited hard enough that
// even a compromised owner session can only walk away with it a handful of
// times a day. 24h is a first for this codebase — every other limiter here
// (see reports.js's exportLimiter) is a 15-minute window at a much higher
// count, because none of them is "the whole history of the workspace" the
// way this one is.
const auditExportLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  message: { error: 'Audit log export is limited to 3 per day. Try again tomorrow.' },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Audit rows on these entity types can carry naira figures in their own
// summary/metadata text (a payment void, a waived amount, a price change, a
// commission total) — the same class of number customers.js/units.js/
// reservations.js already strip from their own direct views for a role
// without financial.view. The audit trail is a second door into the same
// numbers and has to be gated the same way.
const FINANCIAL_ENTITY_TYPES = new Set([
  're_payments', 're_commissions', 're_installment_schedule', 're_units', 're_installment_plans',
]);

// Pure — no database, no Express — so the offline suite can assert on it
// directly. Documentation still gets the row (they may see non-financial
// history for an entity), just with the money-carrying fields removed for
// entity types that carry money.
function redactFinancialAuditRows(rows, canSeeFinancial) {
  if (canSeeFinancial) return rows;
  return (rows || []).map((row) => (
    FINANCIAL_ENTITY_TYPES.has(row.entity_type)
      ? { ...row, summary: null, metadata: {} }
      : row
  ));
}

router.get('/', requirePermission('audit.read'), async (req, res, next) => {
  try {
    // Floored as well as capped — a negative or zero limit reached Postgres
    // unvalidated. actor_id/entity_id are validated as UUID-shaped rather
    // than left to surface as an opaque 500 on a typo'd query string.
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    if (req.query.actor_id && !UUID_RE.test(req.query.actor_id)) {
      return res.status(400).json({ error: 'actor_id must be a valid id.' });
    }
    if (req.query.entity_id && !UUID_RE.test(req.query.entity_id)) {
      return res.status(400).json({ error: 'entity_id must be a valid id.' });
    }

    let query = supabaseAdmin
      .from('re_audit_log')
      .select('*')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (req.query.action) query = query.eq('action', req.query.action);
    if (req.query.entity_type) query = query.eq('entity_type', req.query.entity_type);
    if (req.query.entity_id) query = query.eq('entity_id', req.query.entity_id);
    if (req.query.actor_id) query = query.eq('actor_id', req.query.actor_id);
    if (req.query.from) query = query.gte('created_at', req.query.from);
    if (req.query.to) query = query.lte('created_at', req.query.to);

    const { data, error } = await query;
    if (error) throw error;
    // GET / (audit.read) is DIRECTORS-only (owner + sales_director), and
    // both of those roles already have financial.view — no content gate
    // needed here; see GET /entity/:type/:id below, which documentation can
    // also reach.
    res.json(data);
  } catch (e) { next(e); }
});

// Everything that ever happened to one record — the query an actual dispute
// starts with: "show me this reservation's history". Every authenticated role
// may look up ONE entity's own trail; the bulk log above (GET /) is where the
// director/owner-only line is drawn.
router.get('/entity/:type/:id', requirePermission('audit.readEntity'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_audit_log')
      .select('*')
      .eq('organization_id', req.orgId)
      .eq('entity_type', req.params.type)
      .eq('entity_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Documentation must never see a naira figure (CLAUDE.md's RBAC notes) —
    // audit.readEntity is granted to every role including documentation, and
    // this route otherwise returns raw summary/metadata text with no gate at
    // all.
    res.json(redactFinancialAuditRows(data, canAccess(req.orgRole, 'financial.view')));
  } catch (e) { next(e); }
});

// The notification outbox lives here rather than under its own prefix because
// it answers the same question in a different register: not "who did this"
// but "what did we actually send the buyer, and did it arrive".
router.get('/notifications', requirePermission('audit.read'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_notifications')
      .select('*')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(Number(req.query.limit) || 100, 500)));

    if (req.query.channel) query = query.eq('channel', req.query.channel);
    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Owner only. No filters — a partial export invites the question "what was
// left out and why", and the whole point of this button is a complete record
// a developer can hand to a lawyer or a regulator unedited.
router.get('/export', auditExportLimiter, requirePermission('audit.export'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_audit_log')
      .select('*')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const rows = data || [];
    const stamp = new Date().toISOString().slice(0, 10);

    // audit.export is owner-only and owner always has financial.view, so
    // unlike GET /entity/:type/:id above this needs no redactFinancialAuditRows
    // pass — there is no role reachable here that this would ever hide
    // something from.
    audit(req, {
      action: 'audit.exported',
      entityType: 're_audit_log',
      summary: `Exported ${rows.length} audit log row(s) to CSV`,
      metadata: { rows: rows.length },
    });

    res
      .type('text/csv; charset=utf-8')
      .attachment(`archta-audit-log-${stamp}.csv`)
      .send(toCsv([
        ['Timestamp', 'created_at'],
        ['User', (r) => r.actor_email || r.actor_kind],
        ['Action', 'action'],
        ['Entity type', 'entity_type'],
        ['Entity ID', (r) => r.entity_id || ''],
        ['Changes summary', (r) => r.summary || ''],
        ['IP address', (r) => r.ip || ''],
      ], rows));
  } catch (e) { next(e); }
});

module.exports = router;
// Attached to the exported router purely for the offline test suite —
// see reservations.js's identical pattern for stripFinancials. The same
// UUID_RE pattern (copied, not imported, to keep each route file
// self-contained) also guards project_id in reports.js and dashboard.js.
module.exports.redactFinancialAuditRows = redactFinancialAuditRows;
module.exports.FINANCIAL_ENTITY_TYPES = FINANCIAL_ENTITY_TYPES;
module.exports.UUID_RE = UUID_RE;
