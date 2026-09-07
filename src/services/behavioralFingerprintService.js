// behavioralFingerprintService.js — SECTION 2 of the intelligence/outcome-
// tracking/AI assistant feature expansion. A per-buyer profile built
// entirely from data already in Archta, in the same spirit creditScoreService
// and contactTimingService already established: recompute-and-overwrite,
// null (not a guess) below a minimum sample size, never throws.
//
// preferred_contact_day_of_week/hour are DELIBERATELY not computed here —
// re_customers.optimal_contact_day/optimal_contact_hour (contactTimingService.js,
// migrations/057) already are that exact concept. See migrations/074's own
// header for the full reasoning. recompute() below reads those two columns
// straight through rather than re-deriving them.
const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosParts } = require('./overdueService');
const creditScore = require('./creditScoreService');

// Same threshold contactTimingService.MIN_PAYMENTS_FOR_PATTERN already
// uses for "is there a real pattern here yet" — reused rather than a
// second arbitrary number picked for a near-identical judgment call.
const MIN_OBSERVATIONS = 3;

const CONTACT_CHANNELS = ['whatsapp', 'email', 'call'];

function mode(values) {
  if (!values.length) return null;
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (const v of values) {
    const count = (counts.get(v) || 0) + 1;
    counts.set(v, count);
    if (count > bestCount) { best = v; bestCount = count; }
  }
  return best;
}

function lagosDayOfMonth(isoString) {
  const { date } = lagosParts(new Date(isoString));
  return Number(date.slice(8, 10));
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

// Pure — everything below takes already-fetched flat arrays, exactly what
// loadFingerprintInputs hands it, so this is directly unit-testable
// without a database (logic.test.js).
function computeFingerprint({ payments = [], promiseBreakdown = { kept: 0, resolved: 0 }, paidOutcomes = [] }) {
  const sampleSizes = {};

  // ── preferred_payment_day_of_month ───────────────────────────────────
  let preferredPaymentDayOfMonth = null;
  sampleSizes.payment_day = payments.length;
  if (payments.length >= MIN_OBSERVATIONS) {
    preferredPaymentDayOfMonth = mode(payments.map((p) => lagosDayOfMonth(p.paid_at)));
  }

  // ── typical_payment_amount_pattern ───────────────────────────────────
  // One live payment against an installment is a single-shot "full" pay;
  // more than one is a "partial" pay that took several transfers to
  // settle. Grouped per schedule_id, not per raw payment row, so an
  // installment settled by three part-payments counts as ONE partial
  // instance, not three.
  let typicalPaymentAmountPattern = null;
  const bySchedule = new Map();
  for (const p of payments) {
    if (!p.schedule_id) continue;
    bySchedule.set(p.schedule_id, (bySchedule.get(p.schedule_id) || 0) + 1);
  }
  const installmentCount = bySchedule.size;
  sampleSizes.payment_pattern = installmentCount;
  if (installmentCount >= MIN_OBSERVATIONS) {
    const fullCount = [...bySchedule.values()].filter((n) => n === 1).length;
    const fullRatio = fullCount / installmentCount;
    typicalPaymentAmountPattern = fullRatio >= 0.8 ? 'full' : fullRatio <= 0.2 ? 'partial' : 'variable';
  }

  // ── promise_reliability_score (0-100) ────────────────────────────────
  // Same kept/resolved ratio creditScoreService.computeFromHistory already
  // computes for its own promise_reliability dimension, read on a plain
  // 0-100 scale instead of that dimension's 20-point weighted contribution.
  let promiseReliabilityScore = null;
  sampleSizes.promise_reliability = promiseBreakdown.resolved;
  if (promiseBreakdown.resolved >= MIN_OBSERVATIONS) {
    promiseReliabilityScore = Math.round((promiseBreakdown.kept / promiseBreakdown.resolved) * 100);
  }

  // ── preferred_contact_channel + avg_days_to_pay_after_reminder ───────
  // Both read off re_action_outcomes' own paid_* rows for this buyer
  // (migrations/073) — channel is the fastest-closing channel among the
  // three the commissioning spec names (sms excluded — see migrations/074's
  // header); avg days is across every paid outcome regardless of channel.
  let preferredContactChannel = null;
  let avgDaysToPayAfterReminder = null;
  sampleSizes.contact_channel = paidOutcomes.filter((o) => CONTACT_CHANNELS.includes(o.channel)).length;
  sampleSizes.days_to_pay = paidOutcomes.length;

  if (paidOutcomes.length >= MIN_OBSERVATIONS) {
    avgDaysToPayAfterReminder = round2(
      paidOutcomes.reduce((sum, o) => sum + (o.days_to_outcome || 0), 0) / paidOutcomes.length
    );
  }

  const byChannel = new Map();
  for (const o of paidOutcomes) {
    if (!CONTACT_CHANNELS.includes(o.channel)) continue;
    if (!byChannel.has(o.channel)) byChannel.set(o.channel, []);
    byChannel.get(o.channel).push(o.days_to_outcome || 0);
  }
  // Every candidate channel needs its OWN minimum sample, not just the
  // total across all three — "WhatsApp: 1 fast payment" beating "Email: 2
  // slower ones" is not a real comparison yet.
  const channelAverages = [...byChannel.entries()]
    .filter(([, days]) => days.length >= MIN_OBSERVATIONS)
    .map(([channel, days]) => ({ channel, avg: days.reduce((a, b) => a + b, 0) / days.length }));
  if (channelAverages.length) {
    channelAverages.sort((a, b) => a.avg - b.avg);
    preferredContactChannel = channelAverages[0].channel;
  }

  return {
    preferred_payment_day_of_month: preferredPaymentDayOfMonth,
    preferred_contact_channel: preferredContactChannel,
    avg_days_to_pay_after_reminder: avgDaysToPayAfterReminder,
    promise_reliability_score: promiseReliabilityScore,
    typical_payment_amount_pattern: typicalPaymentAmountPattern,
    sample_sizes: sampleSizes,
  };
}

async function loadFingerprintInputs(orgId, customerId) {
  const [{ data: payments, error: payErr }, promiseBreakdown, { data: outcomes, error: outErr }] = await Promise.all([
    supabaseAdmin
      .from('re_payments')
      .select('paid_at, schedule_id, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(customer_id)))')
      .eq('organization_id', orgId)
      .eq('re_installment_schedule.re_installment_plans.re_reservations.customer_id', customerId)
      .is('voided_at', null)
      // Same AUDIT FIX (F5) reasoning contactTimingService.loadContactHistory
      // already applies to its own identical query: a reallocation's
      // paid_at is back-office paperwork timing, not the buyer's own.
      .is('reallocated_from_payment_id', null),
    creditScore.computeBreakdown(orgId, customerId)
      .then((b) => ({ kept: b.breakdown.promise_reliability.kept, resolved: b.breakdown.promise_reliability.resolved }))
      .catch(() => ({ kept: 0, resolved: 0 })),
    supabaseAdmin
      .from('re_action_outcomes')
      .select('channel, days_to_outcome')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .in('outcome_type', ['paid_within_24h', 'paid_within_7d', 'paid_within_30d']),
  ]);
  if (payErr) throw payErr;
  if (outErr) throw outErr;

  return {
    payments: (payments || []).filter((p) => p.paid_at),
    promiseBreakdown,
    paidOutcomes: outcomes || [],
  };
}

// Called after every payment event (paymentEvents.onPaymentRecorded) and
// every outcome recorded (outcomeService.closeRow, the one chokepoint every
// other close path in that file funnels through) — never throws, matching
// every other derived-figure recompute in this product.
async function recompute(orgId, customerId) {
  if (!orgId || !customerId) return null;
  try {
    const inputs = await loadFingerprintInputs(orgId, customerId);
    const fingerprint = computeFingerprint(inputs);

    await supabaseAdmin
      .from('re_customers')
      .update({
        preferred_payment_day_of_month: fingerprint.preferred_payment_day_of_month,
        preferred_contact_channel: fingerprint.preferred_contact_channel,
        avg_days_to_pay_after_reminder: fingerprint.avg_days_to_pay_after_reminder,
        promise_reliability_score: fingerprint.promise_reliability_score,
        typical_payment_amount_pattern: fingerprint.typical_payment_amount_pattern,
        behavioral_sample_sizes: fingerprint.sample_sizes,
        behavioral_fingerprint_computed_at: new Date().toISOString(),
      })
      .eq('id', customerId)
      .eq('organization_id', orgId);

    return fingerprint;
  } catch (err) {
    console.warn('[behavioral-fingerprint] could not recompute:', err.message);
    return null;
  }
}

// The buyer drawer's own insight-card sentence, server-formatted so the
// frontend does not carry a second copy of "what counts as enough data" —
// contactTimingService.describeOptimalContact stays client-side (screens.js
// already mirrors it, pre-dating this feature), but every NEW sentence
// this card adds is assembled here, in one place, from whichever pieces
// actually cleared their own minimum sample.
function describeFingerprint(customer) {
  const sentences = [];
  if (customer.preferred_payment_day_of_month != null) {
    sentences.push(`This buyer typically pays on the ${ordinal(customer.preferred_payment_day_of_month)}.`);
  }
  if (customer.preferred_contact_channel && customer.avg_days_to_pay_after_reminder != null) {
    sentences.push(
      `${capitalize(customer.preferred_contact_channel)} messages produce payment within `
      + `${customer.avg_days_to_pay_after_reminder} day(s) on average.`
    );
  } else if (customer.avg_days_to_pay_after_reminder != null) {
    sentences.push(`Payment typically follows contact within ${customer.avg_days_to_pay_after_reminder} day(s).`);
  }
  if (customer.promise_reliability_score != null) {
    sentences.push(`Promise reliability: ${customer.promise_reliability_score}%.`);
  }
  return sentences.length ? sentences.join(' ') : null;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = {
  MIN_OBSERVATIONS, CONTACT_CHANNELS,
  computeFingerprint, recompute, describeFingerprint,
};
