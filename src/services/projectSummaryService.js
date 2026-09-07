// projectSummaryService.js — SECTION 8 of the intelligence/outcome-
// tracking/AI assistant feature expansion, and the last one. A plain-
// English narrative of a completed project's whole life, generated once
// (routes/projects.js's 'project_completed' trigger) from re_project_events
// (migrations/079) — the same table Section 7's Timeline modal reads live.
//
// key_metrics is entirely deterministic — computeKeyMetrics is a pure
// function over the event list, never asked of the model, same rule every
// other numeric figure in this feature expansion follows. summary_text is
// the model's own prose, grounded in nothing but those events, with buyer
// names tokenized the same way aiAssistantService.js already established
// (createRefTokenizer/resolveRefsInText) — reused here, not reimplemented.
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const timeline = require('./projectTimelineService');
const { createRefTokenizer, resolveRefsInText } = require('./aiAssistantService');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = env.openai.briefModel;
const REQUEST_TIMEOUT_MS = 30_000;

function round(n, places) {
  const f = 10 ** places;
  return Math.round(Number(n || 0) * f) / f;
}

// Pure — takes the flat event list projectTimelineService.getTimeline
// hands back. Directly unit-testable (logic.test.js).
function computeKeyMetrics(events) {
  const buyerIds = new Set();
  let defaulted = 0;
  let recovered = 0;
  let totalCollected = 0;
  let firstReservationAt = null;
  let completedAt = null;

  for (const e of events) {
    const d = e.event_data || {};
    if (d.customer_id) buyerIds.add(d.customer_id);
    if (e.event_type === 'buyer_defaulted') defaulted += 1;
    if (e.event_type === 'buyer_recovered') recovered += 1;
    if (e.event_type === 'payment_received') totalCollected += Number(d.amount || 0);
    if (e.event_type === 'reservation_created' && (!firstReservationAt || e.created_at < firstReservationAt)) {
      firstReservationAt = e.created_at;
    }
    if (e.event_type === 'project_completed') completedAt = e.created_at;
  }

  const completionDays = firstReservationAt && completedAt
    ? Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(firstReservationAt)) / 86_400_000))
    : null;

  return {
    total_buyers: buyerIds.size,
    // % of this project's own buyers who ever defaulted — buyerIds.size is
    // the real denominator (not "every reservation"), since one buyer can
    // hold more than one unit.
    default_rate: buyerIds.size ? round(defaulted / buyerIds.size, 4) : null,
    // % of DEFAULTS that were later recovered — null, not 0, when nobody
    // ever defaulted at all (there is nothing to have a recovery rate OF).
    recovery_rate: defaulted ? round(recovered / defaulted, 4) : null,
    completion_days: completionDays,
    total_collected: round(totalCollected, 2),
  };
}

// Turns the raw event list into the same short, buyer-anonymized lines the
// Timeline modal shows a person — the model reads a summary of the
// project's own history, not the raw rows.
function describeEventForModel(e, tokenizer) {
  const d = e.event_data || {};
  const ref = d.customer_id ? tokenizer.refFor(d.customer_id, d.customer_name) : null;
  const date = String(e.created_at).slice(0, 10);
  switch (e.event_type) {
    case 'reservation_created': return `${date}: ${ref || 'a buyer'} reserved a unit${d.plan_total_amount ? ` (₦${Number(d.plan_total_amount).toLocaleString('en-NG')})` : ''}`;
    case 'payment_received': return `${date}: ${ref || 'a buyer'} paid ₦${Number(d.amount || 0).toLocaleString('en-NG')}`;
    case 'buyer_defaulted': return `${date}: ${ref || 'a buyer'} defaulted (${d.overdue_count || '?'} installment(s) overdue)`;
    case 'buyer_recovered': return `${date}: ${ref || 'a buyer'} recovered from arrears`;
    case 'restructure': return `${date}: ${ref || "a buyer's"} plan was restructured`;
    case 'document_generated': return `${date}: a ${String(d.doc_type || 'document').replace(/_/g, ' ')} was generated for ${ref || 'a buyer'}`;
    case 'milestone_completed': return `${date}: construction milestone "${d.milestone_name || ''}" completed`;
    case 'legal_action': return `${date}: legal action taken against ${ref || 'a buyer'}`;
    case 'handover': return `${date}: unit handed over to ${ref || 'a buyer'}`;
    case 'project_completed': return `${date}: project marked complete`;
    default: return `${date}: ${e.event_type}`;
  }
}

function isRetryable(err) {
  if (err.malformedResponse) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const status = Number((/OpenAI (\d{3})/.exec(err.message) || [])[1] || 0);
  if (!status) return true;
  if (status === 429) return true;
  return status >= 500;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestNarrativeFromModel(projectName, metrics, eventLines) {
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You write a short (4-6 sentence) plain-English institutional-memory narrative of a completed real ' +
            'estate project for a Nigerian property developer, from the operational history and metrics given. ' +
            'Cover: how the project went overall, notable buyer defaults and recoveries, any restructures or ' +
            'legal action, and how it wrapped up. Use only the facts given — never invent a figure, a buyer, or an ' +
            'event not in the data. Buyers are identified by a ref token (e.g. BUYER_3) — use that token exactly ' +
            'as given wherever a buyer would be named; it is replaced with their real name automatically. Format ' +
            'amounts in naira with the ₦ symbol.',
        },
        {
          role: 'user',
          content: `Project: ${projectName}\nKey metrics: ${JSON.stringify(metrics)}\nEvent history (chronological):\n${eventLines.join('\n')}`,
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
  if (!content) throw Object.assign(new Error('OpenAI returned an empty summary'), { malformedResponse: true });
  return content;
}

// No model reachable — a factual readout of the metrics, same "the feature
// degrades, it does not disappear" rule every other AI surface in this
// product follows.
function buildFallbackSummary(projectName, metrics) {
  const parts = [
    `${projectName} had ${metrics.total_buyers} buyer(s) and collected ₦${metrics.total_collected.toLocaleString('en-NG')} in total.`,
  ];
  if (metrics.default_rate != null) {
    parts.push(`${Math.round(metrics.default_rate * 100)}% of buyers defaulted at some point`
      + (metrics.recovery_rate != null ? `, of whom ${Math.round(metrics.recovery_rate * 100)}% recovered.` : '.'));
  }
  if (metrics.completion_days != null) {
    parts.push(`The project ran for approximately ${Math.round(metrics.completion_days / 30.44)} month(s) from first reservation to completion.`);
  }
  parts.push('The AI model was unavailable, so this is a direct read of the recorded metrics rather than a written narrative.');
  return parts.join(' ');
}

async function generateSummary(orgId, projectId) {
  const [{ data: project }, events] = await Promise.all([
    supabaseAdmin.from('re_projects').select('id, name').eq('id', projectId).eq('organization_id', orgId).maybeSingle(),
    timeline.getTimeline(orgId, projectId),
  ]);
  if (!project) return null;

  // Chronological, not the Timeline modal's newest-first — a narrative
  // reads start to finish.
  const chronological = [...events].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const metrics = computeKeyMetrics(chronological);
  const tokenizer = createRefTokenizer();
  const eventLines = chronological.map((e) => describeEventForModel(e, tokenizer));

  let summaryText = null;
  let generatedBy = 'model';
  let lastError = env.openai.apiKey ? null : new Error('OPENAI_API_KEY not configured');

  if (env.openai.apiKey) {
    for (const delay of [0, 4_000]) {
      if (delay) await sleep(delay);
      try {
        summaryText = await requestNarrativeFromModel(project.name, metrics, eventLines);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) break;
        console.warn('[project-summary] model attempt failed:', err.message);
      }
    }
  }

  if (lastError || !summaryText) {
    console.warn('[project-summary] falling back to a metrics readout:', lastError?.message);
    summaryText = buildFallbackSummary(project.name, metrics);
    generatedBy = 'fallback';
  } else {
    summaryText = resolveRefsInText(summaryText, tokenizer.nameByRef);
  }

  const { data, error } = await supabaseAdmin
    .from('re_project_summaries')
    .upsert(
      { organization_id: orgId, project_id: projectId, summary_text: summaryText, key_metrics: metrics, generated_by: generatedBy, generated_at: new Date().toISOString() },
      { onConflict: 'organization_id,project_id' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getSummary(orgId, projectId) {
  const { data, error } = await supabaseAdmin
    .from('re_project_summaries')
    .select('summary_text, key_metrics, generated_by, generated_at')
    .eq('organization_id', orgId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// The AI assistant's own institutional-memory lookup (aiAssistantService.js,
// SECTION 8). A question naming a completed project by name gets that
// project's summary folded into its context — matched by substring against
// this workspace's own project names, never a guess at which project a
// vague question "probably" means.
async function findMentionedProjectSummaries(orgId, question) {
  const q = String(question || '').toLowerCase();
  const { data: summaries, error } = await supabaseAdmin
    .from('re_project_summaries')
    .select('summary_text, key_metrics, re_projects(name)')
    .eq('organization_id', orgId);
  if (error) throw error;

  return (summaries || [])
    .filter((s) => s.re_projects?.name && q.includes(s.re_projects.name.toLowerCase()))
    .map((s) => ({ project: s.re_projects.name, summary: s.summary_text, key_metrics: s.key_metrics }));
}

module.exports = {
  computeKeyMetrics,
  buildFallbackSummary,
  generateSummary,
  getSummary,
  findMentionedProjectSummaries,
};
