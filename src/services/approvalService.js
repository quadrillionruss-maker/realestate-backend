// approvalService.js — PROMPT 8, the Unified Approval/Workflow Engine.
// A single table (re_approval_requests, migrations/092) recording every
// sensitive, role-gated decision this product makes: hardship (payment
// pause), bank financing, plan restructures, and bulk-waived installments.
// See that migration's own header for the full design — in short, this
// file NEVER decides anything itself. hardshipService/financingService/
// restructureService/routes/payments.js still own every real state change,
// validation and side effect; this file only records what they did.
//
// "Nothing here throws" — same instrumentation rule
// decisionLedgerService/outcomeService already establish: a tracking write
// failing must never fail the real business action that triggered it. Every
// export below catches internally and returns null on failure rather than
// propagating.
const { supabaseAdmin } = require('../middleware/orgContext');

// Maps a request_type to the ONE existing permission that actually gates
// deciding it (permissions.js) — routes/approvals.js's generic
// POST /:id/approve|reject re-checks THIS, per row, rather than a single
// coarse 'approvals.decide' permission that would wrongly let a sales
// director (hardship.review, reservations.restructure) approve a financing
// or bulk-waive request (both owner-only).
const REQUEST_TYPE_PERMISSION = {
  hardship: 'hardship.review',
  financing: 'financing.manage',
  restructure: 'reservations.restructure',
  bulk_waive: 'payments.waive',
};

// The lowest role actually sufficient to decide each type, per
// permissions.js — DIRECTORS-tier permissions read 'sales_director' (the
// floor of that tier); OWNER-tier permissions read 'owner'. An owner can
// always also act wherever a sales_director can (role hierarchy elsewhere
// in this product), so this is "who is this waiting on", not "who is
// excluded".
const APPROVER_ROLE_BY_TYPE = {
  hardship: 'sales_director',
  financing: 'owner',
  restructure: 'sales_director',
  bulk_waive: 'owner',
};

// ── Async flows (hardship, financing) — a real pending row ────────────────
// Called from hardshipService.requestPause / financingService.requestFinancing
// right after their own insert succeeds.
async function recordRequest(orgId, { requestType, entityType, entityId, requestedBy = null }) {
  try {
    const role = APPROVER_ROLE_BY_TYPE[requestType];
    const { data, error } = await supabaseAdmin
      .from('re_approval_requests')
      .insert({
        organization_id: orgId,
        request_type: requestType,
        entity_type: entityType,
        entity_id: entityId,
        requested_by: requestedBy,
        current_approver_role: role,
        status: 'pending',
        approval_chain: [role],
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('[approvals] could not record request:', err.message);
    return null;
  }
}

// Closes whatever pending row exists for this exact source row — called
// from hardshipService.reviewRequest / financingService.updateRequest
// (status→approved/rejected) directly, NOT only from this file's own
// POST /approvals/:id/approve|reject, so the unified queue stays accurate
// no matter which route — the original flow-specific one or the new
// unified one — actually made the decision. .is('status','pending') is the
// same idempotency guard outcomeService/decisionLedgerService's own
// closeRow already uses: a request already decided is never re-closed.
async function closeForEntity(orgId, entityType, entityId, { status, userId = null, rejectionReason = null }) {
  try {
    const role = await supabaseAdmin
      .from('re_approval_requests')
      .select('current_approver_role')
      .eq('organization_id', orgId)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .eq('status', 'pending')
      .maybeSingle();
    if (role.error) throw role.error;
    if (!role.data) return null; // nothing pending for this row — nothing to close

    const { data, error } = await supabaseAdmin
      .from('re_approval_requests')
      .update({
        status,
        rejection_reason: status === 'rejected' ? rejectionReason : null,
        approvals_received: [{ role: role.data.current_approver_role, user_id: userId, decision: status, decided_at: new Date().toISOString() }],
      })
      .eq('organization_id', orgId)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('[approvals] could not close request:', err.message);
    return null;
  }
}

// ── Direct-action flows (restructure, bulk-waive) — written already
// resolved ────────────────────────────────────────────────────────────────
// See migrations/092's own header for why: neither has a separate pending
// phase today, so pretending one exists here would be inventing a workflow
// this product doesn't actually have. approvals_received is pre-filled with
// the same person who performed the action — they requested and decided it
// in one step, which IS the real approval today (their own permission tier
// is the gate).
async function recordResolved(orgId, { requestType, entityType, entityId, actorUserId }) {
  try {
    const role = APPROVER_ROLE_BY_TYPE[requestType];
    const { data, error } = await supabaseAdmin
      .from('re_approval_requests')
      .insert({
        organization_id: orgId,
        request_type: requestType,
        entity_type: entityType,
        entity_id: entityId,
        requested_by: actorUserId,
        current_approver_role: role,
        status: 'approved',
        approval_chain: [role],
        approvals_received: [{ role, user_id: actorUserId, decision: 'approved', decided_at: new Date().toISOString() }],
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('[approvals] could not record resolved action:', err.message);
    return null;
  }
}

// ── Reads, for routes/approvals.js ─────────────────────────────────────────
async function listPending(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_approval_requests')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'pending')
    .order('requested_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getById(orgId, id) {
  const { data, error } = await supabaseAdmin
    .from('re_approval_requests')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  REQUEST_TYPE_PERMISSION,
  APPROVER_ROLE_BY_TYPE,
  recordRequest,
  closeForEntity,
  recordResolved,
  listPending,
  getById,
};
