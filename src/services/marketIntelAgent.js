// marketIntelAgent.js — SECTION 11, v2's Market Intelligence Agent.
//
// Honest about what a chat-completions call can actually know: this model
// has no live web access, so "competitor price changes" and "new estate
// launches" are the model's general knowledge and reasoning over the org's
// own locations/price points, not a live scrape of anything. The system
// prompt says so explicitly, and the summary is framed as a starting point
// for a human to verify, not a delivered fact — the same "every AI output
// is a proposal" rule the rest of this product's AI features already
// follow, just more load-bearing here than anywhere else, since there is no
// deterministic fallback data source the way aiBrief/forecastService have
// one (their fallbacks are real arithmetic over real rows; this one has
// nothing to compute from without the model).
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday, lagosParts } = require('./overdueService');
const dealManager = require('./dealManager');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = env.openai.briefModel;
const REQUEST_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_NAME = 'market_intel_agent';

const REPORT_SCHEMA = {
  name: 'market_intelligence',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'signals'],
    properties: {
      summary: { type: 'string', description: '2-4 sentence overview for a Nigerian real estate developer' },
      signals: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'detail'],
          properties: {
            category: {
              type: 'string',
              enum: ['competitor_pricing', 'new_launches', 'interest_rates', 'demand_signals'],
            },
            detail: { type: 'string' },
          },
        },
      },
    },
  },
};

async function gatherState(orgId) {
  const { data: projects } = await supabaseAdmin
    .from('re_projects')
    .select('name, location, id')
    .eq('organization_id', orgId)
    .eq('status', 'active');

  const projectIds = (projects || []).map((p) => p.id);
  const { data: units } = projectIds.length
    ? await supabaseAdmin.from('re_units').select('project_id, list_price').eq('organization_id', orgId).in('project_id', projectIds)
    : { data: [] };

  const priceByProject = new Map();
  for (const unit of units || []) {
    const list = priceByProject.get(unit.project_id) || [];
    if (unit.list_price) list.push(Number(unit.list_price));
    priceByProject.set(unit.project_id, list);
  }

  return {
    today: lagosToday(),
    projects: (projects || []).map((p) => {
      const prices = priceByProject.get(p.id) || [];
      return {
        name: p.name,
        location: p.location,
        avg_list_price: prices.length ? Math.round(prices.reduce((s, v) => s + v, 0) / prices.length) : null,
      };
    }),
  };
}

function buildFallback() {
  return {
    summary: 'Market intelligence needs OPENAI_API_KEY configured for this deployment — no signals were generated this week.',
    signals: [],
  };
}

async function requestFromModel(state) {
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_schema', json_schema: REPORT_SCHEMA },
      messages: [
        {
          role: 'system',
          content:
            'You are a Nigerian real estate market analyst. You have no live web access — reason from general '
            + 'knowledge of the Nigerian property market (typical seasonal patterns, CBN interest-rate direction, '
            + 'known demand patterns in the given locations) rather than claiming specific real-time facts you '
            + 'cannot actually know. Never invent a named competitor, a specific launch, or a specific rate figure '
            + 'you are not confident of — describe general signals and trends instead ("estates in this area have '
            + 'recently trended toward smaller unit sizes" rather than naming one). This is a starting point for a '
            + 'human to verify, not a delivered fact.\n\n'
            + 'Cover, where relevant to the given locations and price points: competitor_pricing (how prices in '
            + 'these areas are generally trending), new_launches (the general pace of new development in these '
            + 'areas), interest_rates (how the current Nigerian rate environment affects buyer affordability for '
            + 'this price range), demand_signals (general demand patterns for this type of property/location).',
        },
        { role: 'user', content: `Today is ${state.today}. This developer's active projects:\n${JSON.stringify(state.projects, null, 2)}` },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI ${response.status}: ${detail.slice(0, 200)}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty market intelligence report');

  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object') throw new Error('OpenAI returned JSON that was not a report object');
  return parsed;
}

async function generateReport(orgId) {
  const state = await gatherState(orgId);

  let report;
  let generatedBy = 'ai';
  if (!state.projects.length) {
    report = { summary: 'No active projects to report market intelligence against.', signals: [] };
    generatedBy = 'fallback';
  } else if (!env.openai.apiKey) {
    report = buildFallback();
    generatedBy = 'fallback';
  } else {
    try {
      report = await requestFromModel(state);
    } catch (err) {
      console.error('[market-intel] model call failed, falling back:', err.message);
      report = buildFallback();
      report.model_error = err.message;
      generatedBy = 'fallback';
    }
  }

  const { data, error } = await supabaseAdmin
    .from('re_market_intel_reports')
    .insert({ organization_id: orgId, payload: report })
    .select('id, generated_at, payload')
    .single();
  if (error) throw error;

  return { ...data, generated_by: generatedBy };
}

// Cached 7 days — a Monday-generated report is still the current week's
// answer on Tuesday through Sunday, so nothing re-calls the model until the
// following Monday (or force:true).
async function getOrGenerate(orgId, { force = false } = {}) {
  if (!force) {
    const { data: latest } = await supabaseAdmin
      .from('re_market_intel_reports')
      .select('id, generated_at, payload')
      .eq('organization_id', orgId)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest && Date.now() - Date.parse(latest.generated_at) < CACHE_TTL_MS) {
      return { ...latest, cached: true };
    }
  }
  return { ...(await generateReport(orgId)), cached: false };
}

function isDue(when = new Date()) {
  const { date } = lagosParts(when);
  return new Date(`${date}T12:00:00Z`).getUTCDay() === 1; // Monday
}

// Folds the (cached-or-fresh) report into THAT DAY's already-generated
// brief, same pattern documentAgent.js uses for high_priority_documents —
// one payload, not two competing sources of "what the brief says".
async function foldIntoBrief(orgId, report) {
  const { data: brief } = await supabaseAdmin
    .from('re_ai_briefs').select('id, payload')
    .eq('organization_id', orgId).eq('brief_date', lagosToday()).maybeSingle();
  if (!brief) return;

  await supabaseAdmin
    .from('re_ai_briefs')
    .update({ payload: { ...brief.payload, market_intelligence: report.payload } })
    .eq('id', brief.id);
}

async function runIfDue(orgId, when = new Date()) {
  if (!isDue(when)) return { skipped: 'not_due' };

  const report = await getOrGenerate(orgId, { force: false });
  await foldIntoBrief(orgId, report);
  await dealManager.logAction(orgId, AGENT_NAME, null, 'weekly_market_intelligence', report.cached ? 'reused_cache' : 'generated');
  return report;
}

module.exports = {
  gatherState, buildFallback, generateReport, getOrGenerate, isDue, foldIntoBrief, runIfDue,
};
