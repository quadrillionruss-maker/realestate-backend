// auditService.js — who did what, when, from where.
//
// Allocation and payment disputes in Nigerian property development end up in
// front of lawyers. "Who recorded this ₦5m, and when" has to be answerable
// from the system rather than from someone's memory of a Tuesday.
//
// TWO PROPERTIES THIS FILE GUARANTEES:
//
// 1. Writing the log never fails the action being logged. A payment that was
//    recorded and then failed to audit is still a payment; throwing here would
//    turn a bookkeeping problem into a lost transaction. Failures are warned
//    to stderr and swallowed.
//
// 2. Entries are append-only from the application's side. Nothing in this
//    service updates or deletes re_audit_log, and no route exposes a way to.
//    A log the operator can edit is not evidence.

const { supabaseAdmin } = require('../middleware/orgContext');

// Behind a proxy (Render, Cloudflare) req.ip is the proxy unless trust proxy is
// set — server.js sets it. X-Forwarded-For is read as a fallback and only its
// first entry is kept, since the rest are appended by intermediaries.
function callerIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

// Fire-and-forget from a route handler:
//   audit(req, { action: 'payment.record', entityType: 're_payments', ... })
// Not awaited by most callers on purpose — the response should not wait on a
// second round trip to write history.
function audit(req, { action, entityType, entityId = null, summary = null, metadata = {} }) {
  return write({
    orgId: req.orgId,
    actorId: req.userId || null,
    actorEmail: req.user?.email || null,
    actorKind: 'user',
    ip: callerIp(req),
    action,
    entityType,
    entityId,
    summary,
    metadata,
  });
}

// For work with no HTTP caller behind it: the 07:00 cron, the Paystack
// webhook, the AI brief. actorKind is what distinguishes them in the UI.
function auditSystem({
  orgId,
  actorKind = 'system',
  action,
  entityType,
  entityId = null,
  summary = null,
  metadata = {},
  actorEmail = null,
}) {
  return write({
    orgId,
    actorId: null,
    actorEmail,
    actorKind,
    ip: null,
    action,
    entityType,
    entityId,
    summary,
    metadata,
  });
}

async function write(entry) {
  if (!entry.orgId || !entry.action || !entry.entityType) return;

  try {
    await supabaseAdmin.from('re_audit_log').insert({
      organization_id: entry.orgId,
      actor_id: entry.actorId,
      actor_email: entry.actorEmail,
      actor_kind: entry.actorKind,
      action: entry.action,
      entity_type: entry.entityType,
      // A caller that passes a non-UUID (a Paystack reference, say) would
      // otherwise fail the insert on type, taking the whole entry with it.
      entity_id: isUuid(entry.entityId) ? entry.entityId : null,
      summary: entry.summary,
      metadata: entry.metadata || {},
      ip: entry.ip,
    });
  } catch (err) {
    console.warn(`[audit] could not record ${entry.action}:`, err.message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);

module.exports = { audit, auditSystem, callerIp, isUuid };
