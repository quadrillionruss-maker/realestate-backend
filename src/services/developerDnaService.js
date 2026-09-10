// developerDnaService.js — SECTION 5 of the intelligence/outcome-tracking/
// AI assistant feature expansion. A workspace's own operational
// fingerprint, materialized weekly (jobs/daily.js's Monday sweep, same
// cadence Section 4's recovery playbook already runs on) into
// re_developer_dna (migrations/077) — see that migration's own header for
// why this is stored rather than computed live, and for
// collections_consistency_score's own reasoning (no monthly TARGET exists
// anywhere in this product to compare "actual" against, so this reads as
// this workspace's own trailing-12-month coefficient of variation instead).
const { supabaseAdmin } = require('../middleware/orgContext');
const { mapWithConcurrency } = require('../utils/concurrency');
const commissions = require('./commissionService');

const MIN_PEER_ORGS = 5;

function round(n, places) {
  const f = 10 ** places;
  return Math.round(Number(n || 0) * f) / f;
}

// The Gini coefficient of a non-negative list — 0 is perfectly even (every
// rep closes the same number of deals), approaching 1 is maximally
// concentrated (one rep closes everything). Pure, unit-tested directly.
function giniCoefficient(values) {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0; // no deals closed by anyone yet — no inequality to measure
  let weightedSum = 0;
  for (let i = 0; i < n; i += 1) weightedSum += (i + 1) * sorted[i];
  return round((2 * weightedSum) / (n * sum) - (n + 1) / n, 4);
}

// stddev ÷ mean of a series — lower is more consistent. Needs at least 2
// real (non-null) points to say anything about spread, and a non-zero mean
// to normalize by.
function coefficientOfVariation(values) {
  const real = values.filter((v) => v != null);
  if (real.length < 2) return null;
  const mean = real.reduce((a, b) => a + b, 0) / real.length;
  if (mean === 0) return null;
  const variance = real.reduce((sum, v) => sum + (v - mean) ** 2, 0) / real.length;
  return round(Math.sqrt(variance) / mean, 4);
}

async function computeAvgDefaultRate(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('status, due_date, paid_at, re_installment_plans!inner(organization_id)')
    .eq('re_installment_plans.organization_id', orgId);
  if (error) throw error;

  let due = 0;
  let defaulted = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const row of data || []) {
    if (row.status === 'paid') {
      due += 1;
      const paidOn = String(row.paid_at || '').slice(0, 10);
      if (!(paidOn && row.due_date && paidOn <= row.due_date)) defaulted += 1;
    } else if (row.status === 'overdue') {
      due += 1; defaulted += 1;
    } else if (row.status === 'pending' && row.due_date < today) {
      due += 1; defaulted += 1;
    }
  }
  return due > 0 ? round(defaulted / due, 4) : null;
}

async function computeAvgDaysToAllocationLetter(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_documents')
    .select('generated_at, re_reservations!inner(reserved_at, organization_id)')
    .eq('re_reservations.organization_id', orgId)
    .eq('doc_type', 'allocation_letter')
    .is('superseded_at', null)
    .not('generated_at', 'is', null);
  if (error) throw error;

  const gaps = (data || [])
    .map((d) => (Date.parse(d.generated_at) - Date.parse(d.re_reservations.reserved_at)) / 86_400_000)
    .filter((n) => Number.isFinite(n) && n >= 0);
  return gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length, 2) : null;
}

async function computeMilestoneCompletionRate(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_construction_milestones')
    .select('status')
    .eq('organization_id', orgId);
  if (error) throw error;
  const rows = data || [];
  return rows.length ? round(rows.filter((r) => r.status === 'completed').length / rows.length, 4) : null;
}

// A reservation "has restructured" if any of its plans carries
// restructured_at. The restructuring month is read from the ORIGINAL
// plan's start_date to that timestamp, in whole months — how far into the
// original schedule a renegotiation typically happens.
async function computeRestructuringPattern(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_installment_plans')
    .select('reservation_id, start_date, restructured_at, re_reservations!inner(organization_id, property_type)')
    .eq('re_reservations.organization_id', orgId)
    .neq('re_reservations.property_type', 'rental'); // rentals renew, they do not restructure — see restructureService.js
  if (error) throw error;

  const byReservation = new Map();
  for (const row of data || []) {
    if (!byReservation.has(row.reservation_id)) byReservation.set(row.reservation_id, []);
    byReservation.get(row.reservation_id).push(row);
  }
  if (!byReservation.size) return { restructuring_rate: null, avg_restructuring_month: null };

  let restructuredCount = 0;
  const months = [];
  for (const plans of byReservation.values()) {
    const original = plans.reduce((oldest, p) => (!oldest || p.start_date < oldest.start_date ? p : oldest), null);
    const restructured = plans.find((p) => p.restructured_at);
    if (restructured && original) {
      restructuredCount += 1;
      const monthsIn = (Date.parse(restructured.restructured_at) - Date.parse(original.start_date)) / (30.44 * 86_400_000);
      if (Number.isFinite(monthsIn) && monthsIn >= 0) months.push(monthsIn);
    }
  }

  return {
    restructuring_rate: round(restructuredCount / byReservation.size, 4),
    avg_restructuring_month: months.length ? round(months.reduce((a, b) => a + b, 0) / months.length, 2) : null,
  };
}

async function computePromiseKeptRate(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_action_outcomes')
    .select('outcome_type')
    .eq('organization_id', orgId)
    .eq('action_type', 'promise_recorded')
    .in('outcome_type', ['promised_kept', 'promised_broken']);
  if (error) throw error;
  const rows = data || [];
  return rows.length ? round(rows.filter((r) => r.outcome_type === 'promised_kept').length / rows.length, 4) : null;
}

async function computeAvgCreditScore(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_customers')
    .select('credit_score')
    .eq('organization_id', orgId);
  if (error) throw error;
  const scores = (data || []).map((c) => c.credit_score).filter((s) => s != null);
  return scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length, 2) : null;
}

// Same monthly-bucket shape routes/reports.js's own GET /collections builds
// (not imported from there — that logic lives in a route handler, not a
// service, and this needs only the twelve totals, not that route's full
// response), over the trailing 12 calendar months.
async function computeCollectionsConsistency(orgId) {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCMonth(since.getUTCMonth() - 11);

  const { data, error } = await supabaseAdmin
    .from('re_payments')
    .select('amount, paid_at')
    .eq('organization_id', orgId)
    .gte('paid_at', since.toISOString().slice(0, 10))
    .is('voided_at', null);
  if (error) throw error;

  const buckets = new Map();
  for (let i = 0; i < 12; i += 1) {
    const date = new Date(since);
    date.setUTCMonth(since.getUTCMonth() + i);
    buckets.set(date.toISOString().slice(0, 7), 0);
  }
  for (const payment of data || []) {
    const key = String(payment.paid_at || '').slice(0, 7);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + Number(payment.amount || 0));
  }

  return coefficientOfVariation([...buckets.values()]);
}

async function computeRepGini(orgId) {
  const rows = await commissions.leaderboard(orgId);
  return giniCoefficient(rows.map((r) => r.deals_closed));
}

async function computeDna(orgId) {
  const [
    avgBuyerDefaultRate, avgDaysToLetter, milestoneCompletionRate, restructuring,
    promiseKeptRate, avgCreditScore, collectionsConsistency, repGini,
  ] = await Promise.all([
    computeAvgDefaultRate(orgId),
    computeAvgDaysToAllocationLetter(orgId),
    computeMilestoneCompletionRate(orgId),
    computeRestructuringPattern(orgId),
    computePromiseKeptRate(orgId),
    computeAvgCreditScore(orgId),
    computeCollectionsConsistency(orgId),
    computeRepGini(orgId),
  ]);

  return {
    avg_buyer_default_rate: avgBuyerDefaultRate,
    avg_days_reservation_to_allocation_letter: avgDaysToLetter,
    milestone_completion_rate: milestoneCompletionRate,
    restructuring_rate: restructuring.restructuring_rate,
    avg_restructuring_month: restructuring.avg_restructuring_month,
    promise_kept_rate: promiseKeptRate,
    avg_credit_score: avgCreditScore,
    collections_consistency_score: collectionsConsistency,
    rep_gini_coefficient: repGini,
  };
}

async function recomputeForOrg(orgId) {
  const dna = await computeDna(orgId);
  const { error } = await supabaseAdmin
    .from('re_developer_dna')
    .upsert({ organization_id: orgId, ...dna, computed_at: new Date().toISOString() }, { onConflict: 'organization_id' });
  if (error) throw error;
  return dna;
}

// jobs/daily.js's own Monday sweep — every org that has at least one
// reservation is already the platform-wide list distinct_reservation_org_ids
// (migrations/010) exists for; reused rather than a fourth near-identical
// "every org with X" RPC.
async function recomputeForAllOrgs() {
  const { data: orgRows, error } = await supabaseAdmin.rpc('distinct_reservation_org_ids');
  if (error) throw error;

  // AUDIT FIX (P6) — platform-wide, one org's worth of aggregation queries
  // at a time, serially. mapWithConcurrency(4) matches every other
  // correctly-implemented sweep in this codebase.
  let computed = 0;
  await mapWithConcurrency(orgRows || [], 4, async (row) => {
    try {
      await recomputeForOrg(row.organization_id);
      computed += 1;
    } catch (err) {
      console.warn(`[developer-dna] could not compute for org ${row.organization_id}:`, err.message);
    }
  });
  return { computed };
}

async function getDna(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_developer_dna')
    .select('*')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// "How you compare" — never exposes another org's own row, identity, or
// individual metrics; only ever the platform-wide MEAN of each metric
// (excluding this org's own row from that mean, so a workspace never sees
// its own number folded back into "the average"), and only once at least
// MIN_PEER_ORGS other organizations have a computed row at all.
async function getPeerBenchmark(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_developer_dna')
    .select('avg_buyer_default_rate, avg_days_reservation_to_allocation_letter, milestone_completion_rate, restructuring_rate, avg_restructuring_month, promise_kept_rate, avg_credit_score, collections_consistency_score, rep_gini_coefficient')
    .neq('organization_id', orgId);
  if (error) throw error;

  const peers = data || [];
  if (peers.length < MIN_PEER_ORGS) return { eligible: false, peer_count: peers.length, min_required: MIN_PEER_ORGS };

  const avgOf = (key) => {
    const values = peers.map((p) => p[key]).filter((v) => v != null).map(Number);
    return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 4) : null;
  };

  return {
    eligible: true,
    peer_count: peers.length,
    averages: {
      avg_buyer_default_rate: avgOf('avg_buyer_default_rate'),
      avg_days_reservation_to_allocation_letter: avgOf('avg_days_reservation_to_allocation_letter'),
      milestone_completion_rate: avgOf('milestone_completion_rate'),
      restructuring_rate: avgOf('restructuring_rate'),
      avg_restructuring_month: avgOf('avg_restructuring_month'),
      promise_kept_rate: avgOf('promise_kept_rate'),
      avg_credit_score: avgOf('avg_credit_score'),
      collections_consistency_score: avgOf('collections_consistency_score'),
      rep_gini_coefficient: avgOf('rep_gini_coefficient'),
    },
  };
}

module.exports = {
  MIN_PEER_ORGS,
  giniCoefficient,
  coefficientOfVariation,
  computeDna,
  recomputeForOrg,
  recomputeForAllOrgs,
  getDna,
  getPeerBenchmark,
};
