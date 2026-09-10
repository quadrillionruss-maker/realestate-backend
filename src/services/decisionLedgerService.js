// decisionLedgerService.js — the one place that writes and reads
// re_decision_ledger (migrations/089). Same architecture as
// outcomeService.js's re_action_outcomes, applied to
// recommendation-vs-decision instead of action-vs-payment: a row is created
// the moment a recommendation is compared against what a human actually did
// (outcome_type null — "open") and closed later in place, rather than a
// second row.
//
// NOTHING HERE THROWS. This is instrumentation sitting beside a real
// business action (a payment recorded, a promise logged, a hardship
// reviewed) — the same rule outcomeService.js's own header states, for the
// same reason: losing a ledger row must never turn a real action into a
// failed request.

const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday } = require('./overdueService');
const { mapWithConcurrency } = require('../utils/concurrency');
const { MIN_SAMPLE_SIZE, NO_RESPONSE_WINDOW_DAYS } = require('./outcomeService');

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function daysBetween(fromISO, toISO) {
  return Math.max(0, Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000));
}

// The one function every trigger site calls when a recommendation is
// compared against what a human actually did. Never fails the request that
// triggered it.
async function recordDecision(orgId, {
  customerId = null, reservationId = null, projectId = null,
  recommendationType, archtaRecommendation = null, humanDecision = null, wasOverride = false,
}) {
  try {
    if (!orgId || !recommendationType) return null;
    const { data, error } = await supabaseAdmin
      .from('re_decision_ledger')
      .insert({
        organization_id: orgId,
        customer_id: customerId,
        reservation_id: reservationId,
        project_id: projectId,
        recommendation_type: recommendationType,
        archta_recommendation: archtaRecommendation,
        human_decision: humanDecision,
        was_override: Boolean(wasOverride),
      })
      .select('id')
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('[decision-ledger] could not record decision:', err.message);
    return null;
  }
}

// Operates on an already-fetched row — the shared close primitive every
// public closer below delegates to, same shape as outcomeService.closeRow.
async function closeRow(orgId, row, { outcomeType, amountRecovered = null, outcomeRecordedAt = null }) {
  const recordedAt = outcomeRecordedAt || new Date().toISOString();
  const days = daysBetween(row.created_at, recordedAt);
  const { error } = await supabaseAdmin
    .from('re_decision_ledger')
    .update({
      outcome_type: outcomeType,
      outcome_recorded_at: recordedAt,
      days_to_outcome: days,
      amount_recovered: amountRecovered,
    })
    // Idempotency guard: only ever close a row that is still open. A retry
    // or a re-run sweep that finds this row already closed does nothing
    // rather than overwriting a real outcome with a later, less accurate guess.
    .eq('id', row.id)
    .eq('organization_id', orgId)
    .is('outcome_type', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return days;
}

// Best-effort correlation, same as outcomeService.closeMostRecentOpen: finds
// this customer's single most recently created STILL-OPEN ledger row and
// closes it. Used for payment/promise/escalation attribution.
async function closeOutcome(orgId, customerId, { outcomeType, amountRecovered = null, outcomeRecordedAt = null }) {
  try {
    if (!orgId || !customerId) return null;
    const { data } = await supabaseAdmin
      .from('re_decision_ledger')
      .select('id, created_at')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .is('outcome_type', null)
      .order('created_at', { ascending: false })
      .limit(1);
    const row = data?.[0];
    if (!row) return null;

    return await closeRow(orgId, row, { outcomeType, amountRecovered, outcomeRecordedAt });
  } catch (err) {
    console.warn('[decision-ledger] could not close outcome:', err.message);
    return null;
  }
}

// jobs/daily.js's own nightly sweep. Platform-wide, same NO_RESPONSE_WINDOW_
// DAYS (30) cutoff outcomeService.sweepUnresolvedOutcomes uses for the
// identical "nobody ever followed up on this" state. Closes each fetched row
// directly via closeRow rather than routing back through closeOutcome's own
// customer-scoped lookup — under mapWithConcurrency, two lanes racing to
// find "the most recent open row" for the same customer could otherwise
// close the wrong row twice or skip one.
async function sweepStaleEntries() {
  const cutoff = new Date(Date.now() - NO_RESPONSE_WINDOW_DAYS * 86_400_000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('re_decision_ledger')
    .select('id, organization_id, created_at')
    .is('outcome_type', null)
    .lt('created_at', cutoff);
  if (error) throw error;
  if (!data?.length) return { closed: 0 };

  let closed = 0;
  await mapWithConcurrency(data, 4, async (row) => {
    try {
      await closeRow(row.organization_id, row, { outcomeType: 'ignored' });
      closed += 1;
    } catch (err) {
      console.warn('[decision-ledger] could not sweep-close a row:', err.message);
    }
  });
  return { closed };
}

// GET /customers/:id/decisions (buyer drawer) — newest first.
async function getForCustomer(orgId, customerId) {
  const { data, error } = await supabaseAdmin
    .from('re_decision_ledger')
    .select('id, recommendation_type, archta_recommendation, human_decision, was_override, outcome_type, outcome_recorded_at, days_to_outcome, amount_recovered, created_at')
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// GET /analytics/decision-ledger (owner only, routes/analytics.js).
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

const isPositiveOutcome = (r) => r.outcome_type === 'paid' || r.outcome_type === 'promised';
const isNegativeOutcome = (r) => r.outcome_type === 'ignored' || r.outcome_type === 'escalated';

async function getAnalytics(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_decision_ledger')
    .select('recommendation_type, was_override, outcome_type, days_to_outcome, amount_recovered')
    .eq('organization_id', orgId);
  if (error) throw error;

  const rows = data || [];

  // % of every recommendation a human changed. A single top-level figure,
  // not grouped — omitted below MIN_SAMPLE_SIZE rather than a rate computed
  // from almost nothing.
  const overrideRate = rows.length >= MIN_SAMPLE_SIZE
    ? { rate: round2(rows.filter((r) => r.was_override).length / rows.length), sample_size: rows.length }
    : null;

  // Did overriding actually perform better or worse — only rows with a
  // recorded outcome say anything about that.
  const closedRows = rows.filter((r) => r.outcome_type);
  const outcomeComparison = withSampleGuard(
    closedRows,
    (r) => (r.was_override ? 'overrode' : 'followed'),
    (group) => {
      const withAmount = group.filter((r) => r.amount_recovered != null);
      return {
        group: group[0].was_override ? 'overrode' : 'followed',
        positive_rate: round2(group.filter(isPositiveOutcome).length / group.length),
        negative_rate: round2(group.filter(isNegativeOutcome).length / group.length),
        avg_days_to_outcome: round2(group.reduce((sum, r) => sum + (r.days_to_outcome || 0), 0) / group.length),
        avg_amount_recovered: withAmount.length
          ? round2(withAmount.reduce((sum, r) => sum + Number(r.amount_recovered), 0) / withAmount.length)
          : null,
      };
    }
  );

  // Where overrides cluster.
  const topOverridePatterns = withSampleGuard(
    rows.filter((r) => r.was_override),
    (r) => r.recommendation_type,
    (group) => ({ recommendation_type: group[0].recommendation_type })
  ).sort((a, b) => b.sample_size - a.sample_size);

  return {
    override_rate: overrideRate,
    outcome_comparison: outcomeComparison,
    top_override_patterns: topOverridePatterns,
    min_sample_size: MIN_SAMPLE_SIZE,
  };
}

// Once-per-Lagos-day guard for the brief-order trigger — same pattern
// dealManager.sentToday() already uses (most recent row, compare Lagos
// calendar dates) rather than a UTC-midnight range query.
async function hasRecordedToday(orgId, recommendationType) {
  const { data } = await supabaseAdmin
    .from('re_decision_ledger')
    .select('created_at')
    .eq('organization_id', orgId)
    .eq('recommendation_type', recommendationType)
    .order('created_at', { ascending: false })
    .limit(1);

  const last = data?.[0];
  return Boolean(last && lagosToday(new Date(last.created_at)) === lagosToday());
}

module.exports = {
  recordDecision,
  closeOutcome,
  sweepStaleEntries,
  getForCustomer,
  getAnalytics,
  hasRecordedToday,
};
