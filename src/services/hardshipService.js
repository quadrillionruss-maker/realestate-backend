// hardshipService.js — payment pause / hardship mode, SECTION 4.
//
// A buyer who genuinely cannot pay for a month or two asks, in writing, from
// the portal; an owner or sales director decides, by hand, every time. There
// is no automatic approval path anywhere in this file — see migrations/030's
// own comment for why that is enforced at the database, not just here.
//
// NO INTEREST WAIVER. Approving a request does not forgive anything: it
// pushes every still-PENDING installment's due date forward by pause_months
// months (addMonthsUTC — the same month-arithmetic installmentService uses,
// so "31 Jan + 1 month" clamps to 28 Feb here exactly as it does when a plan
// is first built). The buyer owes exactly what they owed before; they simply
// owe it later, and the plan's own end date moves out to match.
const { supabaseAdmin } = require('../middleware/orgContext');
const { addMonthsUTC } = require('./installmentService');
const { audit, auditSystem } = require('./auditService');
const creditScore = require('./creditScoreService');
const notify = require('./notificationService');
const pushService = require('./pushService');
const portalNotifications = require('./portalNotificationService');
const featureUsage = require('./featureUsageService');
const decisionLedger = require('./decisionLedgerService');
const approvals = require('./approvalService');

const MIN_REASON_LENGTH = 20;
const PAUSE_MONTHS_MAX = 3;

// Decision Ledger — this product has no AI-driven hardship-approval step;
// every request is human-submitted and human-decided (see this file's own
// top comment). This is a small, deterministic, explainable rule — same
// "rules, not a model call" style aiBrief.js's own fallback brief uses — so
// was_override carries real meaning instead of always reading false.
// Reuses creditScoreService.tier()'s existing bands (80/60/40) rather than
// inventing a second scale. Param named `score`, not `creditScore` — that
// name is already this file's own import of the creditScoreService module.
function computeHardshipRecommendation({ score, pauseMonths }) {
  const band = creditScore.tier(score ?? 0).key;
  if (band === 'excellent' || band === 'good') {
    return { action: 'approve', reason: `Buyer credit tier is ${band}.` };
  }
  if (band === 'fair' && pauseMonths <= 1) {
    return { action: 'approve', reason: 'Fair credit tier, short pause requested.' };
  }
  return { action: 'review', reason: `Buyer credit tier is ${band}; a ${pauseMonths}-month pause carries more risk.` };
}

// ── Portal: submit a request ────────────────────────────────────────────
async function requestPause(customer, reservationId, { reason, pauseMonths }) {
  const trimmedReason = String(reason || '').trim();
  if (trimmedReason.length < MIN_REASON_LENGTH) {
    throw badRequest(`reason must be at least ${MIN_REASON_LENGTH} characters`);
  }
  const months = Number(pauseMonths);
  if (!Number.isInteger(months) || months < 1 || months > PAUSE_MONTHS_MAX) {
    throw badRequest(`pause_months must be a whole number between 1 and ${PAUSE_MONTHS_MAX}`);
  }

  // App-level pre-check for a clear message; migrations/030's two partial
  // unique indexes are what actually make either race impossible.
  const { data: existing } = await supabaseAdmin
    .from('re_hardship_requests')
    .select('id, status')
    .eq('organization_id', customer.organization_id)
    .eq('reservation_id', reservationId)
    .in('status', ['pending', 'approved']);

  if ((existing || []).some((r) => r.status === 'approved')) {
    throw badRequest('Payment pause has already been used on this reservation. It can only be used once.');
  }
  if ((existing || []).some((r) => r.status === 'pending')) {
    throw badRequest('A payment pause request is already pending review for this reservation.');
  }

  const { data, error } = await supabaseAdmin
    .from('re_hardship_requests')
    .insert({
      organization_id: customer.organization_id,
      reservation_id: reservationId,
      customer_id: customer.id,
      requested_by_portal: true,
      reason: trimmedReason,
      pause_months: months,
    })
    .select()
    .single();
  if (error) {
    // The unique partial indexes are the backstop for a genuine race between
    // two near-simultaneous submissions — read the same way as every other
    // 23505 in this codebase (a real, expected conflict, not a bug).
    if (error.code === '23505') {
      throw badRequest('A payment pause request already exists for this reservation.');
    }
    throw error;
  }

  auditSystem({
    orgId: customer.organization_id,
    actorKind: 'portal',
    actorEmail: customer.email,
    action: 'hardship.requested',
    entityType: 're_hardship_requests',
    entityId: data.id,
    summary: `${customer.full_name} requested a ${months}-month payment pause from the buyer portal`,
    metadata: { reservation_id: reservationId, pause_months: months },
  });

  // PROMPT 8 — Unified Approval/Workflow Engine. Submitted from the portal
  // by the buyer, not a staff user — requestedBy stays null; the real
  // requester is already this row's own customer_id.
  await approvals.recordRequest(customer.organization_id, {
    requestType: 'hardship', entityType: 're_hardship_requests', entityId: data.id,
  });

  featureUsage.track(customer.organization_id, 'hardship_requested');

  // SECTION 1 — push, owner only. requestPause is the buyer portal's only
  // entry point into this table (requested_by_portal is hardcoded true
  // above), so every hardship request that ever reaches here is exactly
  // the event the spec means by "submitted".
  const ownerIds = await pushService.resolveUserIdsByRole(customer.organization_id, ['owner']);
  await pushService.notify(customer.organization_id, ownerIds, {
    title: 'Payment pause requested',
    body: `${customer.full_name || 'A buyer'} asked for a ${months}-month pause.`,
    url: '/#/customers',
  });

  return data;
}

// ── Staff: list ──────────────────────────────────────────────────────────
async function listRequests(orgId, { status = null, customerId = null } = {}) {
  let query = supabaseAdmin
    .from('re_hardship_requests')
    .select(`
      *, re_customers(id, full_name, phone, email),
      re_reservations(id, re_units(unit_number, re_projects(name)))
    `)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  if (customerId) query = query.eq('customer_id', customerId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ── Staff: approve or deny ──────────────────────────────────────────────
async function reviewRequest(req, hardshipId, decision) {
  if (!['approved', 'denied'].includes(decision)) {
    throw badRequest('status must be approved or denied');
  }

  const { data: request } = await supabaseAdmin
    .from('re_hardship_requests')
    .select('*, re_customers(id, full_name, phone, email, credit_score)')
    .eq('id', hardshipId)
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (!request) return { notFound: true };
  if (request.status !== 'pending') {
    throw Object.assign(new Error('This request has already been reviewed.'), { statusCode: 409 });
  }

  const now = new Date().toISOString();
  const customer = request.re_customers;

  // Decision Ledger — computed and recorded once, here, before the branch:
  // wasOverride is a pure comparison between the computed recommendation and
  // `decision` (already known — it's this function's own parameter), not
  // something that depends on which branch's side effects run below.
  const recommendation = computeHardshipRecommendation({ score: customer?.credit_score, pauseMonths: request.pause_months });
  await decisionLedger.recordDecision(req.orgId, {
    customerId: request.customer_id,
    reservationId: request.reservation_id,
    recommendationType: 'hardship',
    archtaRecommendation: { action: recommendation.action, reason: recommendation.reason },
    humanDecision: { action: decision, user_id: req.userId },
    wasOverride: (recommendation.action === 'approve') !== (decision === 'approved'),
  });

  // PROMPT 8 — closes whatever pending re_approval_requests row this
  // request opened, regardless of whether this PATCH or the unified
  // POST /approvals/:id/approve|reject is what actually got called (see
  // approvalService.closeForEntity's own comment). 'denied' here maps to
  // this table's own 'rejected', matching re_approval_requests' status enum.
  await approvals.closeForEntity(req.orgId, 're_hardship_requests', hardshipId, {
    status: decision === 'approved' ? 'approved' : 'rejected',
    userId: req.userId,
  });

  if (decision === 'approved') {
    await applyPause(req.orgId, request.reservation_id, request.pause_months);

    const { data: updated, error } = await supabaseAdmin
      .from('re_hardship_requests')
      .update({ status: 'approved', reviewed_by: req.userId, reviewed_at: now, applied_at: now })
      .eq('id', hardshipId)
      .eq('organization_id', req.orgId)
      .select()
      .single();
    if (error) throw error;

    // The 15-point penalty is not a direct write here — it is baked into
    // creditScoreService.computeFromHistory (an approved hardship request
    // counts as one use, see that file), so recomputing is what actually
    // applies it, the same way every other credit-affecting event in this
    // product updates the score: by recomputing from the underlying facts,
    // never by mutating the number directly.
    await creditScore.recompute(req.orgId, request.customer_id);

    audit(req, {
      action: 'hardship.approved',
      entityType: 're_hardship_requests',
      entityId: hardshipId,
      summary: `Payment pause approved for ${customer?.full_name || 'buyer'} — ${request.pause_months} month(s)`,
      metadata: { reservation_id: request.reservation_id, pause_months: request.pause_months },
    });

    await notifyBuyer(req.orgId, customer, {
      heading: 'Your payment pause has been approved',
      message: `Hi ${customer?.full_name || ''}, your request to pause payments for `
        + `${request.pause_months} month${request.pause_months > 1 ? 's' : ''} has been approved. `
        + 'Your remaining installment dates have been moved back accordingly — nothing owed has been forgiven, '
        + 'it is simply due later. Thank you for letting us know.',
    });

    // SECTION 20 — the portal bell. Both outcomes (approved/denied) use the
    // one 'hardship_approved' type the spec's own enum names — the title
    // text is what actually distinguishes them for the buyer reading it.
    if (customer?.id) {
      await portalNotifications.notify(req.orgId, customer.id, 'hardship_approved',
        'Your payment pause was approved', `${request.pause_months} month(s) — your schedule has been updated.`);
    }

    return updated;
  }

  const { data: updated, error } = await supabaseAdmin
    .from('re_hardship_requests')
    .update({ status: 'denied', reviewed_by: req.userId, reviewed_at: now })
    .eq('id', hardshipId)
    .eq('organization_id', req.orgId)
    .select()
    .single();
  if (error) throw error;

  audit(req, {
    action: 'hardship.denied',
    entityType: 're_hardship_requests',
    entityId: hardshipId,
    summary: `Payment pause request denied for ${customer?.full_name || 'buyer'}`,
    metadata: { reservation_id: request.reservation_id },
  });

  await notifyBuyer(req.orgId, customer, {
    heading: 'Your payment pause request was not approved',
    message: `Hi ${customer?.full_name || ''}, we have reviewed your request to pause payments `
      + `(reason given: "${request.reason}") and are not able to approve it at this time. `
      + 'Please contact us to discuss your options.',
  });

  if (customer?.id) {
    await portalNotifications.notify(req.orgId, customer.id, 'hardship_approved',
      'Your payment pause request was reviewed', 'It was not approved this time. Contact us to discuss your options.');
  }

  return updated;
}

// Pushes every still-PENDING installment on the reservation's ACTIVE plan
// forward by `months` — see this file's own top comment for why 'pending'
// only (never 'overdue' or 'paid') and why nothing about the amount changes.
async function applyPause(orgId, reservationId, months) {
  const { data: plan } = await supabaseAdmin
    .from('re_installment_plans')
    .select('id')
    .eq('organization_id', orgId)
    .eq('reservation_id', reservationId)
    .eq('status', 'active')
    .maybeSingle();
  if (!plan) return { moved: 0 };

  const { data: rows } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, due_date')
    .eq('organization_id', orgId)
    .eq('plan_id', plan.id)
    .eq('status', 'pending');

  for (const row of rows || []) {
    const newDate = addMonthsUTC(new Date(`${row.due_date}T00:00:00Z`), months);
    await supabaseAdmin
      .from('re_installment_schedule')
      .update({ due_date: newDate.toISOString().slice(0, 10) })
      .eq('id', row.id)
      .eq('organization_id', orgId);
  }

  return { moved: rows?.length || 0 };
}

async function notifyBuyer(orgId, customer, { heading, message }) {
  if (!customer) return;
  if (customer.email) {
    await notify.sendEmail({
      orgId,
      to: customer.email,
      subject: heading,
      html: notify.emailShell({ heading, intro: message }),
      text: message,
      template: 'hardship_review',
      relatedType: 're_customers',
      relatedId: customer.id,
    });
  }
  if (customer.phone) {
    await notify.sendWhatsApp({
      orgId,
      to: customer.phone,
      body: message,
      template: 'hardship_review',
      relatedType: 're_customers',
      relatedId: customer.id,
    });
  }
}

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

module.exports = {
  MIN_REASON_LENGTH,
  PAUSE_MONTHS_MAX,
  requestPause,
  listRequests,
  reviewRequest,
  applyPause,
  // Exported for logic.test.js — pure, no database, directly unit-testable.
  computeHardshipRecommendation,
};
