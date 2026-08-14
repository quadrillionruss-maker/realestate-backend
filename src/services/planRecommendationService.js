// planRecommendationService.js — smart payment plan AI (SECTION 7).
//
// Called interactively from the "New reservation" modal — a rep is waiting
// on screen, so unlike aiBrief.js's three-attempt backoff (a background cron
// job with nobody watching) this makes exactly ONE model attempt and falls
// straight to a deterministic, tier-based heuristic on any failure. A slow
// or wrong AI suggestion is worse here than a fast, sensible rule-based one
// — the rep can always ignore either.
//
// No customer_ref/PII-stripping dance like aiBrief/forecastService need:
// nothing sent to OpenAI here is personal — a unit price, a project name, a
// credit_score number and aggregate counts of other buyers' plan
// structures, never a name, phone or email.
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { tier: creditTier } = require('./creditScoreService');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = env.openai.briefModel;
const REQUEST_TIMEOUT_MS = 20_000;

const round1 = (value) => Math.round(Number(value) * 10) / 10;
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const RECOMMENDATION_SCHEMA = {
  name: 'plan_recommendation',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['recommended_installments', 'recommended_deposit_percent', 'recommended_frequency', 'reasoning'],
    properties: {
      recommended_installments: { type: 'integer', minimum: 1, maximum: 120 },
      recommended_deposit_percent: { type: 'number', minimum: 0, maximum: 100 },
      recommended_frequency: { type: 'string', enum: ['monthly', 'quarterly'] },
      reasoning: { type: 'string', description: '2-3 sentences a sales rep can read aloud to justify the suggestion' },
    },
  },
};

// ── State gathering ─────────────────────────────────────────────────────────
async function gatherPlanState(orgId, customerId, unitId) {
  const [{ data: unit, error: unitErr }, { data: customer, error: custErr }] = await Promise.all([
    supabaseAdmin.from('re_units')
      .select('id, list_price, project_id, re_projects(name, location)')
      .eq('id', unitId).eq('organization_id', orgId).maybeSingle(),
    supabaseAdmin.from('re_customers')
      .select('id, credit_score')
      .eq('id', customerId).eq('organization_id', orgId).maybeSingle(),
  ]);
  if (unitErr) throw unitErr;
  if (custErr) throw custErr;
  if (!unit) throw Object.assign(new Error('Unit not found.'), { statusCode: 404 });
  if (!customer) throw Object.assign(new Error('Customer not found.'), { statusCode: 404 });

  // Comparable plans: every plan ever built for a unit in the SAME project —
  // "how has this specific development been financed so far" is a sharper
  // comparison than the whole org's book, which may span very different
  // price points.
  const { data: sameProjectReservations, error: projErr } = await supabaseAdmin
    .from('re_reservations')
    .select(`
      id,
      re_units!inner(project_id),
      re_installment_plans(number_of_installments, frequency, total_amount, status,
        re_installment_schedule(status))
    `)
    .eq('organization_id', orgId)
    .eq('re_units.project_id', unit.project_id)
    .neq('status', 'cancelled');
  if (projErr) throw projErr;

  const comparablePlans = [];
  let projectPlansTotal = 0;
  let projectPlansEverOverdue = 0;
  for (const reservation of sameProjectReservations || []) {
    for (const plan of asArray(reservation.re_installment_plans)) {
      projectPlansTotal += 1;
      const everOverdue = (plan.re_installment_schedule || []).some((row) => row.status === 'overdue');
      if (everOverdue) projectPlansEverOverdue += 1;
      comparablePlans.push({
        number_of_installments: plan.number_of_installments,
        frequency: plan.frequency,
        total_amount: Number(plan.total_amount),
      });
    }
  }

  // Org-wide default rate bucketed by plan length — "similar plan
  // structures" per the product spec, read as "plans of a similar duration",
  // since that is the one structural choice actually being recommended here.
  const { data: allPlans, error: allPlansErr } = await supabaseAdmin
    .from('re_installment_plans')
    .select('number_of_installments, re_installment_schedule(status)')
    .eq('organization_id', orgId);
  if (allPlansErr) throw allPlansErr;

  const bucketOf = (n) => (n <= 6 ? 'short (1-6 installments)' : n <= 12 ? 'medium (7-12 installments)' : 'long (13+ installments)');
  const buckets = new Map();
  for (const plan of allPlans || []) {
    const key = bucketOf(plan.number_of_installments);
    const entry = buckets.get(key) || { plans: 0, ever_overdue: 0 };
    entry.plans += 1;
    if ((plan.re_installment_schedule || []).some((row) => row.status === 'overdue')) entry.ever_overdue += 1;
    buckets.set(key, entry);
  }
  const defaultRateByPlanLength = [...buckets.entries()].map(([bucket, e]) => ({
    bucket, plans: e.plans, default_rate_percent: e.plans ? round1((e.ever_overdue / e.plans) * 100) : 0,
  }));

  return {
    unit_price: Number(unit.list_price || 0),
    project_name: unit.re_projects?.name || null,
    project_location: unit.re_projects?.location || null,
    buyer_credit_score: customer.credit_score,
    buyer_credit_tier: creditTier(customer.credit_score).key,
    comparable_plans_in_project: comparablePlans.slice(0, 20),
    project_default_rate_percent: projectPlansTotal ? round1((projectPlansEverOverdue / projectPlansTotal) * 100) : 0,
    default_rate_by_plan_length: defaultRateByPlanLength,
    customer_id: customer.id,
    unit_id: unit.id,
  };
}

// ── Fallback (deterministic, no model) ──────────────────────────────────────
// A credit-tier-driven heuristic real underwriting already uses informally:
// a riskier buyer gets a shorter plan and a larger deposit, which shrinks
// how much can ever be outstanding at once rather than betting on their
// future payment behaviour improving.
const TIER_HEURISTIC = {
  excellent: { installments: 12, deposit: 10 },
  good: { installments: 12, deposit: 15 },
  fair: { installments: 9, deposit: 20 },
  at_risk: { installments: 6, deposit: 30 },
};

function buildFallbackRecommendation(state) {
  const h = TIER_HEURISTIC[state.buyer_credit_tier] || TIER_HEURISTIC.good;
  return {
    recommended_installments: h.installments,
    recommended_deposit_percent: h.deposit,
    recommended_frequency: 'monthly',
    reasoning: `Buyer credit score ${state.buyer_credit_score} (${state.buyer_credit_tier}) — `
      + `suggesting a ${h.installments}-installment monthly plan with a ${h.deposit}% deposit, `
      + `the standard structure for this credit tier.`,
  };
}

// ── Model call ─────────────────────────────────────────────────────────────
async function requestRecommendationFromModel(state) {
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_schema', json_schema: RECOMMENDATION_SCHEMA },
      messages: [
        {
          role: 'system',
          content:
            'You advise a Nigerian real estate sales rep on how to structure a payment plan for one buyer, ' +
            'about to reserve one unit. Currency is Naira (₦). Base your recommendation strictly on the data given.\n\n' +
            'A lower buyer_credit_score, a higher project_default_rate_percent, or a higher default_rate_percent on ' +
            'longer plans in default_rate_by_plan_length should each push you toward FEWER installments and a ' +
            'HIGHER deposit percentage — this reduces how much can ever be outstanding from a riskier buyer at once. ' +
            'A strong credit score and low default rates support a longer, easier plan with a smaller deposit. ' +
            'Use comparable_plans_in_project to match what has actually worked for this specific development, not ' +
            'just general assumptions. recommended_frequency is monthly unless the buyer\'s plan history in this ' +
            'project favors quarterly. Keep reasoning to 2-3 sentences a sales rep could read aloud to a buyer.',
        },
        { role: 'user', content: JSON.stringify(state, null, 2) },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI ${response.status}: ${detail.slice(0, 200)}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty recommendation');

  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object') throw new Error('OpenAI returned JSON that was not a recommendation object');
  return parsed;
}

// ── Orchestration ──────────────────────────────────────────────────────────
async function recommendPlan(req) {
  const { customer_id: customerId, unit_id: unitId } = req.body || {};
  if (!customerId || !unitId) {
    throw Object.assign(new Error('customer_id and unit_id are required.'), { statusCode: 400 });
  }

  const state = await gatherPlanState(req.orgId, customerId, unitId);

  let recommendation;
  let generatedBy = 'ai';
  if (!env.openai.apiKey) {
    recommendation = buildFallbackRecommendation(state);
    generatedBy = 'fallback';
  } else {
    try {
      recommendation = await requestRecommendationFromModel(state);
    } catch (err) {
      console.error('[plan-recommendation] model call failed, falling back:', err.message);
      recommendation = buildFallbackRecommendation(state);
      generatedBy = 'fallback';
    }
  }

  const { data, error } = await supabaseAdmin
    .from('re_plan_recommendations')
    .insert({
      organization_id: req.orgId,
      customer_id: customerId,
      unit_id: unitId,
      requested_by_user_id: req.userId,
      recommended_installments: recommendation.recommended_installments,
      recommended_deposit_percent: recommendation.recommended_deposit_percent,
      recommended_frequency: recommendation.recommended_frequency,
      reasoning: recommendation.reasoning,
      generated_by: generatedBy,
    })
    .select()
    .single();
  if (error) throw error;

  return data;
}

// Records whether the rep actually used the suggestion — accepted:true also
// carries which reservation resulted, so "of the plans this suggested, how
// many were actually used" doesn't have to guess from accepted alone.
async function recordDecision(orgId, recommendationId, accepted, reservationId = null) {
  const { data, error } = await supabaseAdmin
    .from('re_plan_recommendations')
    .update({ accepted: Boolean(accepted), reservation_id: accepted ? reservationId : null })
    .eq('id', recommendationId)
    .eq('organization_id', orgId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  gatherPlanState,
  buildFallbackRecommendation,
  recommendPlan,
  recordDecision,
};
