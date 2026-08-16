// dealManager.js — SECTION 11. The gatekeeper every v2 agent's outbound
// action goes through before it sends anything.
//
// "Every agent output is a proposal by default" (docs/AI_WORKFORCE.md) — for
// v2 that permission is granted at the workspace level by configuring
// WhatsApp, not assumed. clearance() is the one function that turns that
// document's four rules into code, checked fresh on every call, never
// cached:
//   1. Is this org's WhatsApp actually configured?
//   2. Is a human already handling this buyer (a rep acted on their record
//      in the last 24 hours)?
//   3. Has THIS message already gone out today?
//   4. Has the buyer opted out?
//
// Every decision — sent or skipped — is written to re_agent_actions via
// logAction(). A skipped action is not a non-event: "why didn't the agent
// follow up with this buyer" is exactly the question this table exists to
// answer, same reasoning re_notifications records a 'skipped' send as a
// distinct outcome from 'failed'.
const { supabaseAdmin } = require('../middleware/orgContext');
const notify = require('./notificationService');
const { lagosToday } = require('./overdueService');
const featureUsage = require('./featureUsageService');

const HUMAN_HANDLING_WINDOW_MS = 24 * 60 * 60 * 1000;

async function isWhatsAppConfigured(orgId) {
  const { token, phoneNumberId } = await notify.resolveWhatsAppCredentials(orgId);
  return Boolean(token && phoneNumberId);
}

// "A human isn't already handling this conversation" — read as: has a staff
// member taken any recorded action on this buyer's own record OR one of
// their reservations in the last 24 hours (recording a payment, resolving a
// promise, editing the buyer, changing a reservation's status...). Two
// separate queries rather than one PostgREST or-filter, on purpose — that
// filter syntax is easy to get subtly wrong across nested and()/in(), and
// wrong here means an agent either goes silent on an active rep
// conversation or spams over one, neither acceptable to get wrong for the
// sake of one fewer round trip.
async function isHumanHandling(orgId, customerId, reservationIds = []) {
  const since = new Date(Date.now() - HUMAN_HANDLING_WINDOW_MS).toISOString();

  const [customerActivity, reservationActivity] = await Promise.all([
    supabaseAdmin.from('re_audit_log').select('id')
      .eq('organization_id', orgId).eq('actor_kind', 'user')
      .eq('entity_type', 're_customers').eq('entity_id', customerId)
      .gte('created_at', since).limit(1),
    reservationIds.length
      ? supabaseAdmin.from('re_audit_log').select('id')
          .eq('organization_id', orgId).eq('actor_kind', 'user')
          .eq('entity_type', 're_reservations').in('entity_id', reservationIds)
          .gte('created_at', since).limit(1)
      : Promise.resolve({ data: [] }),
  ]);

  return Boolean(customerActivity.data?.length || reservationActivity.data?.length);
}

// Read from re_notifications rather than a separate counter — it already
// records every send with the template that produced it, so "did THIS
// specific message go out today" needs no new bookkeeping. Compared by
// Lagos calendar day (lagosToday), not a rolling 24h window: "today" is
// what a human filing this away would mean by it.
async function sentToday(orgId, customerId, template) {
  const { data } = await supabaseAdmin
    .from('re_notifications')
    .select('created_at')
    .eq('organization_id', orgId)
    .eq('channel', 'whatsapp')
    .eq('related_type', 're_customers')
    .eq('related_id', customerId)
    .eq('template', template)
    .order('created_at', { ascending: false })
    .limit(1);

  const last = data?.[0];
  return Boolean(last && lagosToday(new Date(last.created_at)) === lagosToday());
}

// The one call every agent makes before sending anything. `template`
// identifies WHICH message this is (drives the "already sent today" check);
// `reservationIds` is whatever reservations the human-handling check should
// also cover — pass none for an action that isn't reservation-scoped.
async function clearance(orgId, customer, template, reservationIds = []) {
  if (!customer) return { allowed: false, reason: 'no_customer' };
  if (customer.whatsapp_opt_out) return { allowed: false, reason: 'opted_out' };

  if (!(await isWhatsAppConfigured(orgId))) return { allowed: false, reason: 'whatsapp_not_configured' };
  if (await isHumanHandling(orgId, customer.id, reservationIds)) return { allowed: false, reason: 'human_handling' };
  if (await sentToday(orgId, customer.id, template)) return { allowed: false, reason: 'already_sent_today' };

  return { allowed: true, reason: null };
}

async function logAction(orgId, agentName, customerId, actionType, outcome) {
  const { error } = await supabaseAdmin.from('re_agent_actions').insert({
    organization_id: orgId,
    agent_name: agentName,
    customer_id: customerId || null,
    action_type: actionType,
    outcome: String(outcome).slice(0, 500),
  });
  // Logging failing must not take the agent down with it — same rule
  // notificationService.js's record() follows for its own write.
  if (error) console.warn('[deal-manager] could not log agent action:', error.message);
  featureUsage.track(orgId, 'agent_action');
}

// The one call an agent makes to both check clearance AND record the
// outcome in one place, so no agent can send a message and forget to log
// it, or log 'sent' without actually sending. Returns whatever
// notify.sendWhatsApp returned, or null if clearance was refused.
async function sendWithClearance(orgId, agentName, customer, { template, body, actionType, reservationIds = [], relatedType = 're_customers', relatedId = null }) {
  const decision = await clearance(orgId, customer, template, reservationIds);
  if (!decision.allowed) {
    await logAction(orgId, agentName, customer?.id, actionType, `skipped: ${decision.reason}`);
    return null;
  }

  const result = await notify.sendWhatsApp({
    orgId, to: customer.phone, body, template,
    relatedType, relatedId: relatedId || customer.id,
  });
  await logAction(orgId, agentName, customer.id, actionType, result.status);
  return result;
}

module.exports = {
  isWhatsAppConfigured,
  isHumanHandling,
  sentToday,
  clearance,
  logAction,
  sendWithClearance,
};
