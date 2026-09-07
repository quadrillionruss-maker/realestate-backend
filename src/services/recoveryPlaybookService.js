// recoveryPlaybookService.js — SECTION 4 of the intelligence/outcome-
// tracking/AI assistant feature expansion. "For each escalation stage,
// what actually works" — materialized weekly (jobs/daily.js, Mondays) from
// re_action_outcomes (migrations/073), read live everywhere else in this
// feature expansion. See migrations/076's own header for why this is
// stored rather than computed per-request the way Section 1/3's routes are.
const { supabaseAdmin } = require('../middleware/orgContext');
const { STAGES } = require('./escalationService');
const { PAID_OUTCOME_TYPES, MIN_SAMPLE_SIZE } = require('./outcomeService');

// The commissioning spec's own explicit number — separate from
// outcomeService.MIN_SAMPLE_SIZE (5), which gates the finer best_channel/
// best_action_type slice WITHIN an already-qualifying stage.
const MIN_STAGE_SAMPLE_SIZE = 10;

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}
function round4(n) {
  return Math.round(Number(n || 0) * 10000) / 10000;
}

// Pure — takes the flat rows for ONE stage and returns what belongs on
// that stage's playbook row. Directly unit-testable (logic.test.js).
function computeStageRecommendation(rows) {
  const sampleSize = rows.length;
  if (sampleSize < MIN_STAGE_SAMPLE_SIZE) {
    return { recovery_rate: null, avg_days_to_recovery: null, best_channel: null, best_action_type: null, sample_size: sampleSize };
  }

  const isRecovered = (r) => PAID_OUTCOME_TYPES.includes(r.outcome_type);
  const recovered = rows.filter(isRecovered);
  const recoveryRate = round4(recovered.length / sampleSize);
  const avgDaysToRecovery = recovered.length
    ? round2(recovered.reduce((sum, r) => sum + (r.days_to_outcome || 0), 0) / recovered.length)
    : null;

  const bestOf = (keyFn) => {
    const groups = new Map();
    for (const r of rows) {
      const key = keyFn(r);
      if (key == null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const candidates = [...groups.entries()]
      .filter(([, group]) => group.length >= MIN_SAMPLE_SIZE)
      .map(([key, group]) => ({ key, rate: group.filter(isRecovered).length / group.length }));
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.rate - a.rate);
    return candidates[0].key;
  };

  return {
    recovery_rate: recoveryRate,
    avg_days_to_recovery: avgDaysToRecovery,
    best_channel: bestOf((r) => r.channel),
    best_action_type: bestOf((r) => r.action_type),
    sample_size: sampleSize,
  };
}

async function computePlaybook(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_action_outcomes')
    .select('escalation_stage_at_action, outcome_type, days_to_outcome, channel, action_type')
    .eq('organization_id', orgId)
    .not('outcome_type', 'is', null);
  if (error) throw error;

  const rows = data || [];
  const byStage = new Map(STAGES.map((s) => [s.key, []]));
  for (const row of rows) {
    if (byStage.has(row.escalation_stage_at_action)) {
      byStage.get(row.escalation_stage_at_action).push(row);
    }
  }

  const computedAt = new Date().toISOString();
  const upserts = STAGES.map((stage) => ({
    organization_id: orgId,
    escalation_stage: stage.key,
    ...computeStageRecommendation(byStage.get(stage.key) || []),
    computed_at: computedAt,
  }));

  const { error: upsertErr } = await supabaseAdmin
    .from('re_recovery_playbook')
    .upsert(upserts, { onConflict: 'organization_id,escalation_stage' });
  if (upsertErr) throw upsertErr;

  return { stages: upserts.length };
}

// jobs/daily.js's own weekly (Monday) sweep — platform-wide, same shape as
// every other org-iterating sweep in that file. Never throws for one org's
// failure the way markOverdue's own per-org loop doesn't either.
async function recomputeForAllOrgs() {
  const { data: orgRows, error } = await supabaseAdmin.rpc('distinct_action_outcome_org_ids');
  if (error) throw error;

  let computed = 0;
  for (const row of orgRows || []) {
    try {
      await computePlaybook(row.organization_id);
      computed += 1;
    } catch (err) {
      console.warn(`[recovery-playbook] could not compute for org ${row.organization_id}:`, err.message);
    }
  }
  return { computed };
}

async function getPlaybook(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_recovery_playbook')
    .select('escalation_stage, recovery_rate, avg_days_to_recovery, best_channel, best_action_type, sample_size, computed_at')
    .eq('organization_id', orgId);
  if (error) throw error;

  const byStage = new Map((data || []).map((r) => [r.escalation_stage, r]));
  // Every stage, in STAGES' own order, even one the weekly job has never
  // computed yet (a brand-new workspace) — "not enough data yet" reads the
  // same whether the row is absent or present with sample_size below the
  // floor, so the route always returns a complete, orderly list.
  return STAGES.map((stage) => {
    const row = byStage.get(stage.key);
    return {
      escalation_stage: stage.key,
      escalation_label: stage.label,
      recovery_rate: row?.recovery_rate != null ? Number(row.recovery_rate) : null,
      avg_days_to_recovery: row?.avg_days_to_recovery != null ? Number(row.avg_days_to_recovery) : null,
      best_channel: row?.best_channel || null,
      best_action_type: row?.best_action_type || null,
      sample_size: row?.sample_size || 0,
      has_enough_data: (row?.sample_size || 0) >= MIN_STAGE_SAMPLE_SIZE,
      computed_at: row?.computed_at || null,
    };
  });
}

module.exports = {
  MIN_STAGE_SAMPLE_SIZE,
  computeStageRecommendation,
  computePlaybook,
  recomputeForAllOrgs,
  getPlaybook,
};
