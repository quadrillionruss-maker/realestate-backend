// outcomeService.js — SECTION 1 of the intelligence/outcome-tracking/AI
// assistant feature expansion. The one place that writes and reads
// re_action_outcomes (migrations/073) — every caller that takes an action
// toward getting a buyer to pay goes through recordAction() here, and every
// caller that later learns what happened goes through one of the close*
// functions. See that migration's own header for the table's shape and the
// reasoning behind attribution_method / source_entity_type+id.
//
// NOTHING HERE THROWS. This is instrumentation sitting beside a real
// business action (a payment recorded, a promise logged, a WhatsApp sent) —
// the same rule paymentEvents.js's own header states for exactly the same
// reason: losing an analytics row must never turn a real action into a
// failed request.
//
// 'ignored' vs 'no_response' — the commissioning spec's own safeguards
// flagged these as the same state and asked for one canonical value. Only
// 'no_response' is ever written; nothing in this file (or the migration's
// check constraint) recognises 'ignored'.

const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday, lagosParts } = require('./overdueService');
const { mapWithConcurrency } = require('../utils/concurrency');

// The awaiting-payment window. The commissioning spec's own body text said
// "close open outcomes older than 7 days with no_response" in one place and
// separately defined paid_within_30d as a valid outcome in another — taken
// literally, a 7-day close would make paid_within_30d unreachable for any
// payment landing on day 8-30, since the row this would close is already
// gone. Widened to 30 days (the widest payment bucket the spec itself
// defines) so all three payment buckets stay reachable; anything genuinely
// unresolved past 30 days still closes as no_response. Documented as a
// deviation in this section's own report, not a silent change.
const NO_RESPONSE_WINDOW_DAYS = 30;

// promise_recorded and restructure_offered are never touched by the
// no-response sweep — they close through their own dedicated paths
// (promiseService's sweep/resolve, restructureService.restructure itself)
// and doing so is not optional the way "did anyone reply" is, so leaving
// one open past 30 days would just be a bug in this file, not a fact worth
// recording as silence.
const AWAITING_PAYMENT_ACTION_TYPES = [
  'whatsapp_sent', 'email_sent', 'call_logged', 'agent_followup', 'campaign_sent',
];

const PAID_BUCKETS = [
  { maxDays: 1, outcomeType: 'paid_within_24h' },
  { maxDays: 7, outcomeType: 'paid_within_7d' },
  { maxDays: 30, outcomeType: 'paid_within_30d' },
];

// Pure — no database — so this is unit-tested directly (logic.test.js)
// rather than only indirectly through a payment round trip.
function pickPaidBucket(daysToOutcome) {
  if (daysToOutcome == null || daysToOutcome < 0) return null;
  const bucket = PAID_BUCKETS.find((b) => daysToOutcome <= b.maxDays);
  return bucket ? bucket.outcomeType : null;
}

function daysBetween(fromISO, toISO) {
  return Math.max(0, Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000));
}

// Snapshotted onto the row at write time — see the migration header for why
// this must never be re-derived live from the buyer's CURRENT state later.
async function snapshotBuyerContext(orgId, customerId, reservationId) {
  const today = lagosToday();
  const [{ data: customer }, oldestOverdue] = await Promise.all([
    supabaseAdmin.from('re_customers').select('credit_score').eq('id', customerId).eq('organization_id', orgId).maybeSingle(),
    reservationId
      ? supabaseAdmin
          .from('re_installment_schedule')
          .select('due_date, re_installment_plans!inner(reservation_id)')
          .eq('organization_id', orgId)
          .eq('re_installment_plans.reservation_id', reservationId)
          .eq('status', 'overdue')
          .order('due_date', { ascending: true })
          .limit(1)
      : Promise.resolve({ data: [] }),
  ]);

  let escalationStage = null;
  if (reservationId) {
    const { data: reservation } = await supabaseAdmin
      .from('re_reservations').select('escalation_stage').eq('id', reservationId).eq('organization_id', orgId).maybeSingle();
    escalationStage = reservation?.escalation_stage || null;
  }

  const oldestDueDate = oldestOverdue.data?.[0]?.due_date || null;

  return {
    buyer_credit_score_at_action: customer?.credit_score ?? null,
    buyer_days_overdue_at_action: oldestDueDate ? daysBetween(oldestDueDate, today) : 0,
    escalation_stage_at_action: escalationStage,
  };
}

// SECTION 3 (feature expansion) — "by message type: when specific amounts
// are mentioned vs generic reminders". Grounded in the actual text, not a
// guess based on which service sent it — a naira figure (₦, or "NGN"
// followed by digits) in the body is 'specific'; the same body with
// neither is 'generic'. Pure, so it is directly unit-tested.
function classifyMessageSpecificity(messageText) {
  if (!messageText) return null;
  return /₦\s*[\d,]|\bngn\s*[\d,]/i.test(messageText) ? 'specific' : 'generic';
}

// The one function every trigger site calls when an action happens.
// sourceEntityType/sourceEntityId are optional — pass them when this action
// has a precise domain row to close against later (a promise, a campaign
// send); leave them null for actions payment-attribution will close via
// closeMostRecentOpen instead. messageText is optional too — pass the
// actual body when the caller has one (a WhatsApp/campaign/SMS send); a
// call_logged or promise_recorded action has no message text and leaves
// message_specificity null rather than a fabricated guess.
async function recordAction(orgId, {
  customerId, reservationId = null, actionType, channel = null,
  sourceEntityType = null, sourceEntityId = null, actionTakenAt = null, messageText = null,
}) {
  try {
    if (!orgId || !customerId || !actionType) return null;
    const context = await snapshotBuyerContext(orgId, customerId, reservationId);

    const { data, error } = await supabaseAdmin
      .from('re_action_outcomes')
      .insert({
        organization_id: orgId,
        customer_id: customerId,
        reservation_id: reservationId,
        action_type: actionType,
        action_taken_at: actionTakenAt || new Date().toISOString(),
        channel,
        source_entity_type: sourceEntityType,
        source_entity_id: sourceEntityId,
        message_specificity: classifyMessageSpecificity(messageText),
        ...context,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('[outcome-service] could not record action:', err.message);
    return null;
  }
}

async function closeRow(orgId, row, { outcomeType, amountRecovered = null, attributionMethod, outcomeRecordedAt = null }) {
  const recordedAt = outcomeRecordedAt || new Date().toISOString();
  const days = daysBetween(row.action_taken_at, recordedAt);
  const { error } = await supabaseAdmin
    .from('re_action_outcomes')
    .update({
      outcome_type: outcomeType,
      outcome_recorded_at: recordedAt,
      days_to_outcome: days,
      amount_recovered: amountRecovered,
      attribution_method: attributionMethod,
    })
    // Idempotency guard: only ever close a row that is still open. A
    // webhook retry or a re-run sweep that finds this row already closed
    // does nothing rather than overwriting a real outcome with a later,
    // less accurate guess.
    .eq('id', row.id)
    .eq('organization_id', orgId)
    .is('outcome_type', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return days;
}

// Closes the exact row this domain entity created — a promise, a
// restructure, a campaign send. customerId is required and filtered on
// alongside source_entity_type/id: a campaign's own id is shared by every
// recipient it was sent to (one re_campaigns row, many re_action_outcomes
// rows), so the source entity id alone is not enough to pick out the one
// row that belongs to THIS buyer. Idempotent by construction: a second call
// for the same (customer, source_entity_type, source_entity_id) finds no
// open row left (the .is('outcome_type', null) filter inside closeRow) and
// does nothing.
async function closeBySource(orgId, customerId, sourceEntityType, sourceEntityId, { outcomeType, amountRecovered = null, outcomeRecordedAt = null }) {
  try {
    const { data: row } = await supabaseAdmin
      .from('re_action_outcomes')
      .select('id, action_taken_at')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .eq('source_entity_type', sourceEntityType)
      .eq('source_entity_id', sourceEntityId)
      .is('outcome_type', null)
      .maybeSingle();
    if (!row) return null;

    return await closeRow(orgId, row, {
      outcomeType, amountRecovered, outcomeRecordedAt, attributionMethod: 'direct_source_link',
    });
  } catch (err) {
    console.warn('[outcome-service] could not close action by source:', err.message);
    return null;
  }
}

// Best-effort correlation, not proof of causation — see the migration
// header's own note on attribution_method. Finds this customer's single
// most recently taken STILL-OPEN action (optionally restricted to a set of
// action_types) and closes it. Used for payment attribution (any
// awaiting-payment action_type) and for escalation (any open action at
// all — an escalation happening despite recent contact is itself the
// signal worth recording).
async function closeMostRecentOpen(orgId, customerId, { outcomeType, amountRecovered = null, actionTypes = null, outcomeRecordedAt = null }) {
  try {
    let query = supabaseAdmin
      .from('re_action_outcomes')
      .select('id, action_taken_at')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .is('outcome_type', null)
      .order('action_taken_at', { ascending: false })
      .limit(1);
    if (actionTypes) query = query.in('action_type', actionTypes);

    const { data } = await query;
    const row = data?.[0];
    if (!row) return null;

    return await closeRow(orgId, row, {
      outcomeType, amountRecovered, outcomeRecordedAt, attributionMethod: 'most_recent_action',
    });
  } catch (err) {
    console.warn('[outcome-service] could not close most recent action:', err.message);
    return null;
  }
}

// Called from paymentEvents.onPaymentRecorded after a payment settles an
// installment. Picks the bucket from the ACTUAL elapsed days rather than
// trusting a caller to pick one, per the commissioning spec's own safeguard
// against a single payment producing more than one paid_within_* row: this
// closes exactly one row, with exactly one bucket, chosen from the real
// gap between the action and the payment.
async function recordPaymentOutcome(orgId, customerId, amountRecovered) {
  try {
    const { data } = await supabaseAdmin
      .from('re_action_outcomes')
      .select('id, action_taken_at')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .is('outcome_type', null)
      .in('action_type', AWAITING_PAYMENT_ACTION_TYPES)
      .order('action_taken_at', { ascending: false })
      .limit(1);
    const row = data?.[0];
    if (!row) return null;

    const now = new Date().toISOString();
    const days = daysBetween(row.action_taken_at, now);
    const bucket = pickPaidBucket(days);
    if (!bucket) return null; // outside every bucket — nothing to attribute

    return await closeRow(orgId, row, {
      outcomeType: bucket, amountRecovered, outcomeRecordedAt: now, attributionMethod: 'most_recent_action',
    });
  } catch (err) {
    console.warn('[outcome-service] could not record payment outcome:', err.message);
    return null;
  }
}

// jobs/daily.js's own nightly sweep. Only ever touches awaiting-payment
// action types (see AWAITING_PAYMENT_ACTION_TYPES above) — promise/
// restructure rows close through their own paths and are left alone here.
// Safe to re-run: a row this already closed is, by construction, no longer
// matched by the outcome_type-is-null filter.
async function sweepUnresolvedOutcomes(orgId = null) {
  const cutoff = new Date(Date.now() - NO_RESPONSE_WINDOW_DAYS * 86_400_000).toISOString();

  let query = supabaseAdmin
    .from('re_action_outcomes')
    .select('id, organization_id, action_taken_at')
    .is('outcome_type', null)
    .in('action_type', AWAITING_PAYMENT_ACTION_TYPES)
    .lt('action_taken_at', cutoff);
  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) return { closed: 0 };

  // AUDIT FIX (P5) — this runs platform-wide (jobs/daily.js calls it with no
  // orgId), one database round trip per row, serially. mapWithConcurrency(4)
  // matches every other correctly-implemented sweep in this codebase.
  let closed = 0;
  await mapWithConcurrency(data, 4, async (row) => {
    try {
      await closeRow(row.organization_id, row, {
        outcomeType: 'no_response', attributionMethod: 'sweep_closure',
      });
      closed += 1;
    } catch (err) {
      console.warn('[outcome-service] could not sweep-close a row:', err.message);
    }
  });
  return { closed };
}

// ── Analytics ────────────────────────────────────────────────────────────
// GET /analytics/outcomes (owner only, routes/analytics.js). Every group
// below carries its own sample_size, and the route itself omits a group's
// derived rate/figure once that count falls under MIN_SAMPLE_SIZE rather
// than showing a rate computed from almost nothing — the "minimum sample
// sizes" rule this whole feature expansion was commissioned under.
const MIN_SAMPLE_SIZE = 5;
const PAID_OUTCOME_TYPES = ['paid_within_24h', 'paid_within_7d', 'paid_within_30d'];
const PAID_WITHIN_WEEK_TYPES = ['paid_within_24h', 'paid_within_7d'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Africa/Lagos day-of-week for a stored timestamp — same "noon UTC on the
// already-Lagos-correct calendar date" trick contactTimingService.js's own
// lagosDayOfWeek uses, so a contact made at 23:30 Lagos time is grouped
// under the day it actually happened on, not the UTC day that same instant
// falls on.
function lagosDayOfWeekIndex(isoString) {
  const { date } = lagosParts(new Date(isoString));
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function lagosPartOfDay(isoString) {
  const { hour } = lagosParts(new Date(isoString));
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

// Buyer credit score band — deliberately coarse (two tiers, not
// creditScoreService's four) since a channel/day comparison needs "is this
// buyer in good standing or not", not the full excellent/good/fair/at_risk
// spread this table's own sample sizes rarely support slicing that finely.
const creditBand = (score) => (score == null ? null : score >= 70 ? 'good_standing' : 'at_risk');

// 0 / 1-7 / 8-30 / 30+ days overdue at the moment of contact — the same
// escalation-relevant bands escalationService.STAGES' own thresholds
// (1/3/5/7 overdue installments, not days) are already built around, coarsened
// to days since that is what this table snapshots (buyer_days_overdue_at_action),
// not an installment count.
function overdueBand(days) {
  if (days == null) return null;
  if (days <= 0) return 'current';
  if (days <= 7) return '1_7_days';
  if (days <= 30) return '8_30_days';
  return '30_plus_days';
}

function withSampleGuard(rows, keyFn, computeFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, sample_size: group.length, ...computeFn(group) }))
    .filter((g) => g.sample_size >= MIN_SAMPLE_SIZE);
}

async function getOutcomeAnalytics(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_action_outcomes')
    .select('action_type, action_taken_at, channel, outcome_type, days_to_outcome, escalation_stage_at_action, buyer_credit_score_at_action')
    .eq('organization_id', orgId)
    .not('outcome_type', 'is', null);
  if (error) throw error;

  const rows = data || [];
  const isPaid = (r) => PAID_OUTCOME_TYPES.includes(r.outcome_type);

  // Top performing action types by recovery rate.
  const byActionType = withSampleGuard(rows, (r) => r.action_type, (group) => ({
    action_type: group[0].action_type,
    recovery_rate: round2(group.filter(isPaid).length / group.length),
  })).sort((a, b) => b.recovery_rate - a.recovery_rate);

  // Best day of week to contact, by same-outcome-set payment rate.
  const byDayOfWeek = withSampleGuard(rows, (r) => lagosDayOfWeekIndex(r.action_taken_at), (group) => ({
    day: DAY_NAMES[lagosDayOfWeekIndex(group[0].action_taken_at)],
    payment_rate: round2(group.filter(isPaid).length / group.length),
  })).sort((a, b) => b.payment_rate - a.payment_rate);

  // Best channel by buyer credit-score band — reuses the same two-tier
  // banding creditBand() gives every other buyer-segment breakdown in this
  // file, collapsed from creditScoreService's own four tiers since a
  // channel comparison needs "is this buyer in good standing or not", not
  // the full spread.
  const byChannelSegment = withSampleGuard(
    rows.filter((r) => r.channel),
    (r) => `${r.channel}|${creditBand(r.buyer_credit_score_at_action)}`,
    (group) => ({
      channel: group[0].channel,
      credit_band: creditBand(group[0].buyer_credit_score_at_action),
      recovery_rate: round2(group.filter(isPaid).length / group.length),
    })
  ).sort((a, b) => b.recovery_rate - a.recovery_rate);

  // Average days to payment by escalation stage.
  const byEscalationStage = withSampleGuard(
    rows.filter(isPaid),
    (r) => r.escalation_stage_at_action,
    (group) => ({
      escalation_stage: group[0].escalation_stage_at_action,
      avg_days_to_payment: round2(group.reduce((sum, r) => sum + (r.days_to_outcome || 0), 0) / group.length),
    })
  );

  // Promise kept rate by credit-score band.
  const { data: promiseRows, error: promiseErr } = await supabaseAdmin
    .from('re_action_outcomes')
    .select('outcome_type, buyer_credit_score_at_action')
    .eq('organization_id', orgId)
    .eq('action_type', 'promise_recorded')
    .in('outcome_type', ['promised_kept', 'promised_broken']);
  if (promiseErr) throw promiseErr;

  const promiseKeptRateByCreditBand = withSampleGuard(
    promiseRows || [],
    (r) => creditBand(r.buyer_credit_score_at_action),
    (group) => ({
      credit_band: creditBand(group[0].buyer_credit_score_at_action),
      kept_rate: round2(group.filter((r) => r.outcome_type === 'promised_kept').length / group.length),
    })
  );

  return {
    top_action_types_by_recovery_rate: byActionType,
    best_day_of_week_by_outcome: byDayOfWeek,
    best_channel_by_buyer_segment: byChannelSegment,
    avg_days_to_payment_by_escalation_stage: byEscalationStage,
    promise_kept_rate_by_credit_band: promiseKeptRateByCreditBand,
    min_sample_size: MIN_SAMPLE_SIZE,
  };
}

// GET /analytics/communication-effectiveness (owner only, routes/
// analytics.js) — SECTION 3 (feature expansion). Same re_action_outcomes
// table getOutcomeAnalytics reads, different cuts: "which day/time/channel/
// buyer segment/message type actually produces a payment", the questions a
// workspace's communication SCHEDULE gets built on, rather than Section 1's
// own "which action type and buyer-standing pairing recovers debt".
async function getCommunicationEffectiveness(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_action_outcomes')
    .select(`channel, action_taken_at, outcome_type, escalation_stage_at_action,
      buyer_credit_score_at_action, buyer_days_overdue_at_action, message_specificity`)
    .eq('organization_id', orgId)
    .not('outcome_type', 'is', null);
  if (error) throw error;

  const rows = data || [];
  // "produces highest 7-day payment rate" — paid within 24h or 7d counts;
  // paid_within_30d, replied_no_payment, no_response and every non-payment
  // outcome (promised_*, restructured, escalated) do not.
  const paidWithinWeek = (r) => PAID_WITHIN_WEEK_TYPES.includes(r.outcome_type);

  const byDayOfWeek = withSampleGuard(rows, (r) => lagosDayOfWeekIndex(r.action_taken_at), (group) => ({
    day: DAY_NAMES[lagosDayOfWeekIndex(group[0].action_taken_at)],
    payment_rate_within_7d: round2(group.filter(paidWithinWeek).length / group.length),
  })).sort((a, b) => b.payment_rate_within_7d - a.payment_rate_within_7d);

  const byTimeOfDay = withSampleGuard(rows, (r) => lagosPartOfDay(r.action_taken_at), (group) => ({
    part_of_day: lagosPartOfDay(group[0].action_taken_at),
    payment_rate_within_7d: round2(group.filter(paidWithinWeek).length / group.length),
  })).sort((a, b) => b.payment_rate_within_7d - a.payment_rate_within_7d);

  const byChannel = withSampleGuard(rows.filter((r) => r.channel), (r) => r.channel, (group) => ({
    channel: group[0].channel,
    recovery_rate: round2(group.filter(paidWithinWeek).length / group.length),
  })).sort((a, b) => b.recovery_rate - a.recovery_rate);

  const byCreditBand = withSampleGuard(rows, (r) => creditBand(r.buyer_credit_score_at_action), (group) => ({
    credit_band: creditBand(group[0].buyer_credit_score_at_action),
    recovery_rate: round2(group.filter(paidWithinWeek).length / group.length),
  }));

  const byEscalationStage = withSampleGuard(rows, (r) => r.escalation_stage_at_action, (group) => ({
    escalation_stage: group[0].escalation_stage_at_action,
    recovery_rate: round2(group.filter(paidWithinWeek).length / group.length),
  }));

  const byDaysOverdue = withSampleGuard(rows, (r) => overdueBand(r.buyer_days_overdue_at_action), (group) => ({
    days_overdue_band: overdueBand(group[0].buyer_days_overdue_at_action),
    recovery_rate: round2(group.filter(paidWithinWeek).length / group.length),
  }));

  // message_specificity is null for almost every row (see migrations/075's
  // own header) — withSampleGuard already drops a null key via its
  // `key == null` skip, so this naturally reports nothing rather than a
  // rate computed from whichever handful of rows happened to carry a
  // classification.
  const byMessageType = withSampleGuard(rows, (r) => r.message_specificity, (group) => ({
    message_type: group[0].message_specificity,
    recovery_rate: round2(group.filter(paidWithinWeek).length / group.length),
  })).sort((a, b) => b.recovery_rate - a.recovery_rate);

  return {
    best_day_of_week: byDayOfWeek,
    best_time_of_day: byTimeOfDay,
    best_channel: byChannel,
    by_buyer_segment: {
      credit_band: byCreditBand,
      escalation_stage: byEscalationStage,
      days_overdue: byDaysOverdue,
    },
    by_message_type: byMessageType,
    min_sample_size: MIN_SAMPLE_SIZE,
  };
}

// The Reports screen's own "top 3 actionable insights" card. Pure —
// takes getCommunicationEffectiveness' own return shape and turns the
// biggest real gaps in it into plain sentences, so this is directly
// unit-testable and never itself queries anything or calls a model: every
// number in a sentence this returns is one min_sample_size already cleared
// before it ever reached this function.
function deriveTopInsights(effectiveness) {
  const pct = (n) => Math.round(n * 100);
  const candidates = [];

  const days = effectiveness.best_day_of_week;
  if (days.length >= 2) {
    const best = days[0], worst = days[days.length - 1];
    if (best.payment_rate_within_7d > worst.payment_rate_within_7d) {
      candidates.push({
        spread: best.payment_rate_within_7d - worst.payment_rate_within_7d,
        text: `${best.day} contact produces a ${pct(best.payment_rate_within_7d)}% same-week payment rate vs `
          + `${pct(worst.payment_rate_within_7d)}% for ${worst.day}. Consider scheduling more reminders on ${best.day}s.`,
      });
    }
  }

  const times = effectiveness.best_time_of_day;
  if (times.length >= 2) {
    const best = times[0], worst = times[times.length - 1];
    if (best.payment_rate_within_7d > worst.payment_rate_within_7d) {
      candidates.push({
        spread: best.payment_rate_within_7d - worst.payment_rate_within_7d,
        text: `${capitalize(best.part_of_day)} contact produces a ${pct(best.payment_rate_within_7d)}% same-week payment rate vs `
          + `${pct(worst.payment_rate_within_7d)}% in the ${worst.part_of_day}. Consider favoring ${best.part_of_day} sends.`,
      });
    }
  }

  const channels = effectiveness.best_channel;
  if (channels.length >= 2) {
    const best = channels[0], worst = channels[channels.length - 1];
    if (best.recovery_rate > worst.recovery_rate) {
      candidates.push({
        spread: best.recovery_rate - worst.recovery_rate,
        text: `${capitalize(best.channel)} recovers ${pct(best.recovery_rate)}% of debt within a week vs `
          + `${pct(worst.recovery_rate)}% for ${worst.channel}. Consider leading with ${capitalize(best.channel)} where possible.`,
      });
    }
  }

  const messageTypes = effectiveness.by_message_type;
  const specific = messageTypes.find((m) => m.message_type === 'specific');
  const generic = messageTypes.find((m) => m.message_type === 'generic');
  if (specific && generic && specific.recovery_rate !== generic.recovery_rate) {
    const better = specific.recovery_rate > generic.recovery_rate ? specific : generic;
    const worse = better === specific ? generic : specific;
    candidates.push({
      spread: better.recovery_rate - worse.recovery_rate,
      text: `Messages that name a specific amount recover ${pct(specific.recovery_rate)}% within a week vs `
        + `${pct(generic.recovery_rate)}% for generic reminders. `
        + (better === specific ? 'Consider naming the exact amount owed in reminders.' : 'Worth reviewing why specific amounts underperform generic wording here.'),
    });
  }

  return candidates.sort((a, b) => b.spread - a.spread).slice(0, 3).map((c) => c.text);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

module.exports = {
  recordAction,
  closeBySource,
  closeMostRecentOpen,
  recordPaymentOutcome,
  classifyMessageSpecificity,
  getCommunicationEffectiveness,
  deriveTopInsights,
  // Exported for recoveryPlaybookService (SECTION 4 — feature expansion):
  // the same "what counts as recovered" and "what counts as enough of a
  // sample" this file's own analytics already use, reused rather than a
  // second, possibly-drifting definition of either.
  PAID_OUTCOME_TYPES,
  MIN_SAMPLE_SIZE,
  sweepUnresolvedOutcomes,
  getOutcomeAnalytics,
  pickPaidBucket,
  AWAITING_PAYMENT_ACTION_TYPES,
  NO_RESPONSE_WINDOW_DAYS,
};
