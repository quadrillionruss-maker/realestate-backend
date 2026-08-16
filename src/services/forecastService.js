// forecastService.js — AI sales forecasting (SECTION 6).
//
// Same shape as aiBrief.js, deliberately: gather real numbers → ask the
// model to reason over them inside a strict JSON schema → fall back to a
// deterministic, rule-based projection when there is no OPENAI_API_KEY or
// the model call fails → store the result either way, marked with which
// kind it is (re_forecasts.generated_by). Buyer and project identities never
// reach OpenAI — see sanitizeStateForModel — the same customer_ref /
// project_ref token convention aiBrief.js uses, resolved back afterward.
//
// Cached 24 hours (getOrGenerateForecast) — a forecast built from the same
// day's numbers would not meaningfully change on a second call an hour
// later, and the owner's Regenerate button is the explicit override for
// "I just changed something and want a fresh read."
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday } = require('./overdueService');
const { tier: creditTier, assessDefaultRisk } = require('./creditScoreService');
const { STAGES } = require('./escalationService');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = env.openai.briefModel;
const REQUEST_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// A candidate list, not the whole buyer book — token budget, and a buyer
// with a perfect record and nothing overdue is not a "risk" worth asking a
// model to rank.
const MAX_RISK_CANDIDATES = 25;
const RISK_RANK = { high: 0, medium: 1, low: 2 };

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const firstPlan = (reservation) => asArray(reservation.re_installment_plans).find((p) => p.status === 'active') || null;

const FORECAST_SCHEMA = {
  name: 'sales_forecast',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['projected_collections_3mo', 'project_completions', 'default_risks', 'recommended_actions'],
    properties: {
      projected_collections_3mo: {
        type: 'object',
        additionalProperties: false,
        required: ['month_1', 'month_2', 'month_3', 'reasoning'],
        properties: {
          month_1: { type: 'number', description: 'Projected total collections, next calendar month, in Naira' },
          month_2: { type: 'number' },
          month_3: { type: 'number' },
          reasoning: { type: 'string' },
        },
      },
      project_completions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['project_ref', 'projected_completion_date', 'reasoning'],
          properties: {
            project_ref: { type: 'string', description: 'The exact project_ref token from the data, e.g. PROJECT_2.' },
            projected_completion_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if collection rate is 0 and a date cannot be projected' },
            reasoning: { type: 'string' },
          },
        },
      },
      default_risks: {
        type: 'array',
        description: 'Up to 5, ranked worst first',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['customer_ref', 'risk_reason'],
          properties: {
            customer_ref: { type: 'string', description: 'The exact customer_ref token from the data, e.g. BUYER_3.' },
            risk_reason: { type: 'string' },
          },
        },
      },
      recommended_actions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete, prioritized actions to accelerate collections',
      },
    },
  },
};

// ── State gathering ─────────────────────────────────────────────────────────
async function gatherForecastState(orgId) {
  const today = lagosToday();
  const twelveMonthsAgo = new Date(Date.parse(today) - 365 * 86_400_000).toISOString().slice(0, 10);
  const sixMonthsAgo = new Date(Date.parse(today) - 182 * 86_400_000).toISOString().slice(0, 10);
  const sixtyDaysAgo = new Date(Date.parse(today) - 60 * 86_400_000).toISOString().slice(0, 10);

  const [projectsRes, reservationsRes, paymentsRes, customersRes] = await Promise.all([
    supabaseAdmin.from('re_projects')
      .select('id, name, status, total_units')
      .eq('organization_id', orgId)
      .eq('status', 'active'),
    supabaseAdmin.from('re_reservations')
      .select(`
        id, status, customer_id,
        re_units!inner(project_id, list_price),
        re_installment_plans(id, status, total_amount,
          re_installment_schedule(id, amount_due, status, due_date, paid_at))
      `)
      .eq('organization_id', orgId)
      .neq('status', 'cancelled'),
    supabaseAdmin.from('re_payments')
      .select('amount, paid_at, schedule_id')
      .eq('organization_id', orgId)
      .gte('paid_at', twelveMonthsAgo)
      .is('voided_at', null),
    supabaseAdmin.from('re_customers')
      .select('id, full_name, credit_score, escalation_stage:re_reservations(escalation_stage)')
      .eq('organization_id', orgId),
  ]);
  for (const r of [projectsRes, reservationsRes, paymentsRes, customersRes]) {
    if (r.error) throw r.error;
  }

  // ── Per-project pipeline + collection rate ────────────────────────────────
  const projectRef = new Map();
  const nameByProjectRef = new Map();
  function refForProject(id, name) {
    if (!id) return null;
    let ref = projectRef.get(id);
    if (!ref) {
      ref = `PROJECT_${projectRef.size + 1}`;
      projectRef.set(id, ref);
      nameByProjectRef.set(ref, name || 'Unnamed project');
    }
    return ref;
  }
  for (const p of projectsRes.data || []) refForProject(p.id, p.name);

  // schedule_id → project_id, so payments (which only carry schedule_id) can
  // be attributed to a project without a second round trip per row.
  const scheduleToProject = new Map();
  const scheduleToCustomer = new Map();
  const projectStats = new Map(); // project_id -> { contracted, collected6mo:[], remaining, overdue }
  for (const p of projectsRes.data || []) {
    projectStats.set(p.id, { contracted: 0, remaining: 0, overdue: 0, monthly: new Map() });
  }

  let orgOverdueAmount = 0;
  let dueEvents = 0;
  let overdueEvents = 0;

  for (const reservation of reservationsRes.data || []) {
    const projectId = reservation.re_units?.project_id;
    const plan = firstPlan(reservation);
    const stats = projectStats.get(projectId);
    // An outright purchase carries no installment plan at all — its
    // contracted value is the unit's own list_price, same fallback
    // groupService.js's contracted-value roll-up already uses.
    if (stats) stats.contracted = round2(stats.contracted + Number(plan?.total_amount || reservation.re_units?.list_price || 0));

    for (const row of plan?.re_installment_schedule || []) {
      scheduleToProject.set(row.id, projectId);
      scheduleToCustomer.set(row.id, reservation.customer_id);

      if (row.status === 'overdue') {
        orgOverdueAmount = round2(orgOverdueAmount + Number(row.amount_due || 0));
        overdueEvents += 1;
        dueEvents += 1;
        if (stats) stats.overdue = round2(stats.overdue + Number(row.amount_due || 0));
      } else if (row.status === 'paid') {
        dueEvents += 1;
      }
      if ((row.status === 'pending' || row.status === 'overdue') && stats) {
        stats.remaining = round2(stats.remaining + Number(row.amount_due || 0));
      }
    }
  }

  const monthlyOrgCollections = new Map(); // 'YYYY-MM' -> amount, last 12 months
  for (const payment of paymentsRes.data || []) {
    const month = String(payment.paid_at || '').slice(0, 7);
    monthlyOrgCollections.set(month, round2((monthlyOrgCollections.get(month) || 0) + Number(payment.amount || 0)));

    const projectId = scheduleToProject.get(payment.schedule_id);
    const stats = projectId ? projectStats.get(projectId) : null;
    if (stats && String(payment.paid_at || '') >= sixMonthsAgo) {
      stats.monthly.set(month, round2((stats.monthly.get(month) || 0) + Number(payment.amount || 0)));
    }
  }

  const projects = (projectsRes.data || []).map((p) => {
    const stats = projectStats.get(p.id) || { contracted: 0, remaining: 0, overdue: 0, monthly: new Map() };
    const monthsWithData = stats.monthly.size || 1;
    const avgMonthlyCollection = round2(
      [...stats.monthly.values()].reduce((sum, v) => sum + v, 0) / monthsWithData
    );
    return {
      project_ref: refForProject(p.id, p.name),
      status: p.status,
      units_total: p.total_units || 0,
      contracted_value: stats.contracted,
      remaining_balance: stats.remaining,
      overdue_amount: stats.overdue,
      avg_monthly_collection_last_6mo: avgMonthlyCollection,
    };
  });

  // ── Default-risk candidates ────────────────────────────────────────────────
  // A candidate is anyone with EITHER a below-Excellent credit score OR a
  // currently overdue installment — "most likely to default in the next 60
  // days" is a judgment about people already showing a signal, not a guess
  // about buyers with a clean record and nothing due.
  const overdueByCustomer = new Map(); // customer_id -> { count, amount }
  for (const reservation of reservationsRes.data || []) {
    const plan = firstPlan(reservation);
    for (const row of plan?.re_installment_schedule || []) {
      if (row.status !== 'overdue') continue;
      const entry = overdueByCustomer.get(reservation.customer_id) || { count: 0, amount: 0 };
      entry.count += 1;
      entry.amount = round2(entry.amount + Number(row.amount_due || 0));
      overdueByCustomer.set(reservation.customer_id, entry);
    }
  }

  const customerRef = new Map();
  const nameByCustomerRef = new Map();
  function refForCustomer(id, name) {
    if (!id) return null;
    let ref = customerRef.get(id);
    if (!ref) {
      ref = `BUYER_${customerRef.size + 1}`;
      customerRef.set(id, ref);
      nameByCustomerRef.set(ref, name || 'Unknown buyer');
    }
    return ref;
  }

  const candidates = (customersRes.data || [])
    .map((c) => {
      const overdue = overdueByCustomer.get(c.id) || { count: 0, amount: 0 };
      // STAGES is ordered none→reminder→formal_notice→final_notice→legal —
      // the "worst" stage across a buyer's reservations is the one with the
      // highest INDEX in that sequence, not the alphabetically-last string
      // ("reminder" sorts after "legal" and "none" but is the mildest stage
      // there is).
      let worstStageIndex = 0;
      for (const r of asArray(c.escalation_stage)) {
        const idx = STAGES.findIndex((s) => s.key === (r.escalation_stage || 'none'));
        if (idx > worstStageIndex) worstStageIndex = idx;
      }
      const worstStage = STAGES[worstStageIndex]?.key || 'none';
      const tierKey = creditTier(c.credit_score).key;
      return {
        id: c.id,
        full_name: c.full_name,
        credit_score: c.credit_score,
        tier: tierKey,
        // OVERRIDE — a stored credit_score can lag a buyer's most recent
        // overdue installments (see creditScoreService.assessDefaultRisk's
        // own comment for why). Computed here, not left to whichever
        // consumer reads risk_candidates next, so the model prompt and the
        // deterministic fallback both see the same signal.
        risk_level: assessDefaultRisk(overdue.count, tierKey),
        overdue_count: overdue.count,
        overdue_amount: overdue.amount,
        escalation_stage: worstStage,
      };
    })
    .filter((c) => c.credit_score < 80 || c.overdue_count > 0)
    // Worst first: high-risk-override candidates before anyone else, then
    // lowest score, then most overdue amount — so truncating to
    // MAX_RISK_CANDIDATES never drops someone more at-risk than someone
    // kept, even when their stored score hasn't caught up to their overdue
    // installments yet.
    .sort((a, b) => RISK_RANK[a.risk_level] - RISK_RANK[b.risk_level]
      || a.credit_score - b.credit_score || b.overdue_amount - a.overdue_amount)
    .slice(0, MAX_RISK_CANDIDATES)
    .map((c) => ({
      customer_ref: refForCustomer(c.id, c.full_name),
      credit_score: c.credit_score,
      tier: c.tier,
      risk_level: c.risk_level,
      overdue_installments: c.overdue_count,
      overdue_amount: c.overdue_amount,
      escalation_stage: c.escalation_stage,
    }));

  const monthlyCollectionsLast12 = [...monthlyOrgCollections.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, amount }));

  return {
    today,
    projects,
    overall: {
      total_overdue_amount: orgOverdueAmount,
      // Share of installments that have actually come due and were paid
      // late or are still unpaid — 'pending' rows not yet due count toward
      // neither side, same reasoning as creditScoreService's own ratio.
      default_rate_percent: dueEvents ? Math.round((overdueEvents / dueEvents) * 1000) / 10 : 0,
      monthly_collections_last_12: monthlyCollectionsLast12,
    },
    risk_candidates: candidates,
    nameByProjectRef,
    nameByCustomerRef,
  };
}

// ── Fallback (deterministic, no model) ──────────────────────────────────────
function buildFallbackForecast(state) {
  const recentMonths = state.overall.monthly_collections_last_12.slice(-3);
  const avgRecent = recentMonths.length
    ? round2(recentMonths.reduce((sum, m) => sum + m.amount, 0) / recentMonths.length)
    : 0;

  const addMonths = (dateStr, n) => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
  };

  return {
    projected_collections_3mo: {
      month_1: avgRecent,
      month_2: avgRecent,
      month_3: avgRecent,
      reasoning: recentMonths.length
        ? `Flat projection from the average of the last ${recentMonths.length} month(s) of actual collections.`
        : 'No recent collection history to project from.',
    },
    project_completions: state.projects.map((p) => ({
      project_ref: p.project_ref,
      projected_completion_date: p.avg_monthly_collection_last_6mo > 0
        ? addMonths(state.today, Math.ceil(p.remaining_balance / p.avg_monthly_collection_last_6mo))
        : null,
      reasoning: p.avg_monthly_collection_last_6mo > 0
        ? `At the last 6 months' average of ₦${p.avg_monthly_collection_last_6mo.toLocaleString('en-NG')}/month against a ₦${p.remaining_balance.toLocaleString('en-NG')} remaining balance.`
        : 'No collections in the last 6 months to project a rate from.',
    })),
    default_risks: state.risk_candidates.slice(0, 5).map((c) => {
      // THE BUG — this text used to read the stored credit_score/tier
      // uncritically, so a buyer with a dozen-plus overdue installments but
      // a score that had not yet been recomputed (see overdueService's own
      // fix) could come out "credit score 100 (Excellent)" right next to a
      // list of the very installments they missed. risk_level is the
      // override: it is HIGH the moment overdue_installments crosses
      // OVERDUE_RISK_OVERRIDE_THRESHOLD, independent of what the score says
      // — see creditScoreService.assessDefaultRisk.
      const riskLevel = c.risk_level || assessDefaultRisk(c.overdue_installments, c.tier);
      const prefix = riskLevel === 'high' ? 'HIGH DEFAULT RISK — ' : '';
      return {
        customer_ref: c.customer_ref,
        risk_reason: c.overdue_installments > 0
          ? `${prefix}${c.overdue_installments} installment(s) currently overdue totalling ₦${c.overdue_amount.toLocaleString('en-NG')}; credit score ${c.credit_score} (${c.tier}).`
          : `Credit score ${c.credit_score} (${c.tier}), no installments currently overdue.`,
      };
    }),
    recommended_actions: [
      state.overall.total_overdue_amount > 0
        ? `₦${state.overall.total_overdue_amount.toLocaleString('en-NG')} is currently overdue across the workspace — prioritize collections calls on the buyers above this week.`
        : 'No installments are currently overdue.',
      state.overall.default_rate_percent > 10
        ? `The overdue rate (${state.overall.default_rate_percent}%) is elevated — consider reviewing payment plan structures for new reservations.`
        : 'The overdue rate is within a normal range.',
    ],
  };
}

// ── Model call ─────────────────────────────────────────────────────────────
function sanitizeStateForModel(state) {
  return {
    today: state.today,
    projects: state.projects,
    overall: state.overall,
    risk_candidates: state.risk_candidates,
  };
}

function resolveRefs(forecast, nameByProjectRef, nameByCustomerRef) {
  return {
    ...forecast,
    project_completions: (forecast.project_completions || []).map(({ project_ref, ...rest }) => ({
      project_name: nameByProjectRef.get(project_ref) || project_ref,
      ...rest,
    })),
    default_risks: (forecast.default_risks || []).map(({ customer_ref, ...rest }) => ({
      customer_name: nameByCustomerRef.get(customer_ref) || 'this buyer',
      ...rest,
    })),
  };
}

async function requestForecastFromModel(state) {
  const promptState = sanitizeStateForModel(state);
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_schema', json_schema: FORECAST_SCHEMA },
      messages: [
        {
          role: 'system',
          content:
            'You are a financial analyst for a Nigerian real estate developer, producing a sales and collections ' +
            'forecast. Currency is Naira (₦). Base every figure strictly on the data given — never invent a ' +
            'project, buyer, amount or date not present in it.\n\n' +
            'Projects are identified by project_ref (e.g. "PROJECT_2") and buyers by customer_ref (e.g. "BUYER_5") ' +
            '— you are not given real names. Use these tokens exactly as given in your output.\n\n' +
            'projected_collections_3mo: extrapolate from monthly_collections_last_12, accounting for any trend ' +
            '(accelerating, flat, or declining) and typical Nigerian seasonal patterns (December/festive-period ' +
            'and January school-fees pressure tend to soften collections; look for that shape in the data rather ' +
            'than assuming it).\n\n' +
            'project_completions: for each project, project when its remaining_balance would be fully collected ' +
            'at its own avg_monthly_collection_last_6mo. If that rate is 0, return null for the date and say why ' +
            'in reasoning.\n\n' +
            'default_risks: choose up to 5 of the given risk_candidates most likely to default in the next 60 ' +
            'days, ranked worst first, using credit_score, overdue_installments/overdue_amount and ' +
            'escalation_stage together — never pick a buyer not present in risk_candidates. Each candidate ' +
            'carries risk_level ("high"/"medium"/"low"), already computed to override a stale credit_score: a ' +
            'buyer can show a high numeric score while several installments sit overdue underneath it, because ' +
            'that score has not been recomputed since. Treat risk_level "high" as a real default risk and say so ' +
            'plainly in risk_reason — never describe a risk_level "high" buyer as low-risk or "excellent" on the ' +
            'strength of credit_score alone.\n\n' +
            'recommended_actions: concrete, prioritized steps a Nigerian sales/collections team could act on this ' +
            'week to accelerate collections, grounded in the actual numbers given.',
        },
        {
          role: 'user',
          content: `Today is ${state.today} (Africa/Lagos). Current state:\n${JSON.stringify(promptState, null, 2)}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI ${response.status}: ${detail.slice(0, 200)}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new Error('OpenAI returned an empty forecast'), { malformedResponse: true });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw Object.assign(new Error(`OpenAI returned unparsable JSON: ${err.message}`), { malformedResponse: true });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(new Error('OpenAI returned JSON that was not a forecast object'), { malformedResponse: true });
  }

  return resolveRefs(parsed, state.nameByProjectRef, state.nameByCustomerRef);
}

// ── Orchestration ──────────────────────────────────────────────────────────
async function generateForecast(orgId) {
  const state = await gatherForecastState(orgId);

  let forecast;
  let generatedBy = 'ai';

  if (!env.openai.apiKey) {
    forecast = resolveRefs(buildFallbackForecast(state), state.nameByProjectRef, state.nameByCustomerRef);
    generatedBy = 'fallback';
  } else {
    try {
      forecast = await requestForecastFromModel(state);
    } catch (err) {
      console.error('[forecast] model call failed, falling back:', err.message);
      forecast = resolveRefs(buildFallbackForecast(state), state.nameByProjectRef, state.nameByCustomerRef);
      forecast.model_error = String(err.message).slice(0, 300);
      generatedBy = 'fallback';
    }
  }

  const { data, error } = await supabaseAdmin
    .from('re_forecasts')
    .insert({ organization_id: orgId, generated_by: generatedBy, payload: forecast })
    .select('id, generated_at, generated_by, payload')
    .single();
  if (error) throw error;

  return data;
}

// Cached 24 hours; `force` (the Regenerate button) always calls the model
// again regardless of age.
async function getOrGenerateForecast(orgId, { force = false } = {}) {
  if (!force) {
    const { data: latest } = await supabaseAdmin
      .from('re_forecasts')
      .select('id, generated_at, generated_by, payload')
      .eq('organization_id', orgId)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest && Date.now() - Date.parse(latest.generated_at) < CACHE_TTL_MS) {
      return { ...latest, cached: true };
    }
  }
  const fresh = await generateForecast(orgId);
  return { ...fresh, cached: false };
}

module.exports = {
  gatherForecastState,
  buildFallbackForecast,
  sanitizeStateForModel,
  resolveRefs,
  generateForecast,
  getOrGenerateForecast,
};
