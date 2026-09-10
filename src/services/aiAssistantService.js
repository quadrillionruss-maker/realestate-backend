// aiAssistantService.js — SECTION 6 of the intelligence/outcome-tracking/
// AI assistant feature expansion. "Archta Intelligence": a conversational
// question-answering assistant over a workspace's own real data.
//
// ── Buyer privacy — the same boundary aiBrief.js already draws ───────────
// aiBrief.js's own header is explicit: "Buyer names, phone numbers and
// emails never leave this server: OpenAI never receives them, only opaque
// per-buyer tokens" (customer_ref, e.g. BUYER_3), resolved back to real
// names only once the model's response is back in this process. The
// commissioning spec for this assistant asks it to "name specific buyers"
// in its answers — that is about what the OWNER reads, not about what
// OpenAI receives, so this file follows the exact same ref/resolve
// convention aiBrief already established rather than inventing a second,
// laxer one: every buyer anywhere in the context sent to the model is a
// BUYER_N token; buildAnswer() below replaces every token in the model's
// own reply with the real name before anyone sees it. Project and sales
// rep names are not tokenized — aiBrief's own stripPII() does not touch
// them either, since neither is a buyer's personal data.
//
// ── Context, not a raw database connection ───────────────────────────────
// "Do not give the model raw unrestricted database access" — every number
// below is read by THIS server first, gathered by question category (see
// detectQuestionCategory), and handed to the model as one small structured
// object. The model never runs a query of its own.
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday } = require('./overdueService');
const defaultRisk = require('./defaultRiskService');
const projectHealth = require('./projectHealthService');
const commissions = require('./commissionService');
const outcomes = require('./outcomeService');
const recoveryPlaybook = require('./recoveryPlaybookService');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = env.openai.briefModel;
// Shorter than aiBrief's 45s/three-attempt retry — that runs unattended
// overnight; this runs with a person watching a chat window, so a
// worthwhile second attempt has to be quick or not worth making at all.
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [0, 2_000];
const MAX_CONVERSATION_HISTORY = 10;

const CATEGORIES = ['collections', 'buyers', 'projects', 'sales', 'documents', 'executive'];

// AUDIT FIX (P10) — pages through a whole table rather than one unbounded
// select() — gatherBaseContext's own credit-score distribution and
// gatherCategoryContext's own document-status breakdown both used to fetch
// every re_customers/re_documents row this org has EVER had just to bucket-
// count them, a read that grows forever as the org's buyer/document history
// grows, for a workspace years into operation with this assistant open
// routinely.
const CONTEXT_PAGE_SIZE = 1000;
async function fetchAllForContext(table, column, orgId) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(column)
      .eq('organization_id', orgId)
      .order('id', { ascending: true })
      .range(offset, offset + CONTEXT_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < CONTEXT_PAGE_SIZE) break;
    offset += CONTEXT_PAGE_SIZE;
  }
  return rows;
}

// Pure — keyword-matched against the question text, checked in a fixed
// order so a question mentioning more than one area still resolves to
// exactly one category (the FIRST one it matches), same as aiBrief's own
// STAGES lookups always resolving to one definite answer. 'executive' is
// the default: a question naming none of these specifically gets the full
// operational snapshot, which is the safer thing to hand a broad question
// rather than an arbitrarily narrow guess.
function detectQuestionCategory(question) {
  const q = String(question || '').toLowerCase();
  // \w* on every stem, not a bare \b(word)\b — "collect" alone would never
  // match inside "collections", since \b needs an actual word boundary
  // immediately after "collect" and "ions" leaves none.
  if (/\b(collect\w*|revenue|cash ?flow|income|paid|payment\w*)\b/.test(q)) return 'collections';
  if (/\b(buyer\w*|customer\w*|default\w*|risk\w*|credit score)\b/.test(q)) return 'buyers';
  if (/\b(project\w*|unit\w*|construction|milestone\w*|estate\w*)\b/.test(q)) return 'projects';
  if (/\b(reps?|sales ?rep\w*|commission\w*|leaderboard|salesperson\w*)\b/.test(q)) return 'sales';
  if (/\b(document\w*|letter\w*|deed\w*|sign\w*|unsigned|agreement\w*)\b/.test(q)) return 'documents';
  return 'executive';
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}
function naira(n) {
  return '₦' + Math.abs(Number(n || 0)).toLocaleString('en-NG', { maximumFractionDigits: 0 });
}

// ── Buyer ref tokenization — see this file's own header ──────────────────
function createRefTokenizer() {
  const refByCustomerId = new Map();
  const nameByRef = new Map();
  let counter = 0;

  function refFor(customerId, fullName) {
    if (!customerId) return null;
    if (!refByCustomerId.has(customerId)) {
      counter += 1;
      const ref = `BUYER_${counter}`;
      refByCustomerId.set(customerId, ref);
      nameByRef.set(ref, fullName || 'Unnamed buyer');
    }
    return refByCustomerId.get(customerId);
  }

  return { refFor, nameByRef };
}

function resolveRefsInText(text, nameByRef) {
  let out = String(text || '');
  for (const [ref, name] of nameByRef) out = out.replace(new RegExp(`\\b${ref}\\b`, 'g'), name);
  return out;
}

// ── Base context — always included, every category ───────────────────────
async function gatherBaseContext(orgId, tokenizer) {
  const today = lagosToday();
  const thisMonthStart = `${today.slice(0, 7)}-01`;
  const lastMonthDate = new Date(`${thisMonthStart}T00:00:00Z`);
  lastMonthDate.setUTCMonth(lastMonthDate.getUTCMonth() - 1);
  const lastMonthStart = lastMonthDate.toISOString().slice(0, 7) + '-01';

  const [
    { data: thisMonthPayments }, { data: lastMonthPayments },
    { data: overdueRows }, topDefaulters, creditRows,
    { data: agentActions }, communicationEffectiveness, playbook,
  ] = await Promise.all([
    supabaseAdmin.from('re_payments').select('amount').eq('organization_id', orgId)
      .gte('paid_at', thisMonthStart).is('voided_at', null),
    supabaseAdmin.from('re_payments').select('amount').eq('organization_id', orgId)
      .gte('paid_at', lastMonthStart).lt('paid_at', thisMonthStart).is('voided_at', null),
    supabaseAdmin.from('re_installment_schedule')
      .select(`amount_due, due_date, re_installment_plans!inner(re_reservations!inner(
        id, re_customers(id, full_name)))`)
      .eq('organization_id', orgId)
      .eq('status', 'overdue'),
    defaultRisk.topDefaultRisks(orgId, 5),
    fetchAllForContext('re_customers', 'credit_score', orgId),
    supabaseAdmin.from('re_agent_actions').select('agent_name, outcome')
      .eq('organization_id', orgId).gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString()),
    outcomes.getCommunicationEffectiveness(orgId).catch(() => null),
    recoveryPlaybook.getPlaybook(orgId).catch(() => []),
  ]);

  const overdueByCustomer = new Map();
  for (const row of overdueRows || []) {
    const customer = row.re_installment_plans?.re_reservations?.re_customers;
    if (!customer) continue;
    const ref = tokenizer.refFor(customer.id, customer.full_name);
    const entry = overdueByCustomer.get(ref) || { customer_ref: ref, overdue_amount: 0, count: 0, oldest_due: row.due_date };
    entry.overdue_amount = round2(entry.overdue_amount + Number(row.amount_due || 0));
    entry.count += 1;
    if (row.due_date < entry.oldest_due) entry.oldest_due = row.due_date;
    overdueByCustomer.set(ref, entry);
  }
  const atRiskBuyers = [...overdueByCustomer.values()]
    .sort((a, b) => b.overdue_amount - a.overdue_amount)
    .slice(0, 10)
    .map((r) => ({ ...r, days_late: Math.max(0, Math.round((Date.parse(today) - Date.parse(r.oldest_due)) / 86_400_000)) }));

  const creditBand = (score) => (score == null ? 'unknown' : score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'at_risk');
  const creditDistribution = { excellent: 0, good: 0, fair: 0, at_risk: 0, unknown: 0 };
  for (const row of creditRows || []) creditDistribution[creditBand(row.credit_score)] += 1;

  const agentSummary = {};
  for (const row of agentActions || []) {
    if (!agentSummary[row.agent_name]) agentSummary[row.agent_name] = { sent: 0, skipped: 0, other: 0 };
    const bucket = String(row.outcome).startsWith('sent') ? 'sent' : String(row.outcome).startsWith('skipped') ? 'skipped' : 'other';
    agentSummary[row.agent_name][bucket] += 1;
  }

  return {
    today,
    collections: {
      this_month: round2((thisMonthPayments || []).reduce((s, p) => s + Number(p.amount || 0), 0)),
      last_month: round2((lastMonthPayments || []).reduce((s, p) => s + Number(p.amount || 0), 0)),
    },
    overdue: {
      total_amount: round2([...overdueByCustomer.values()].reduce((s, r) => s + r.overdue_amount, 0)),
      buyer_count: overdueByCustomer.size,
    },
    at_risk_buyers: atRiskBuyers,
    top_defaulting_buyers: topDefaulters.map((r) => ({
      customer_ref: tokenizer.refFor(r.customer_id, r.customer_name),
      default_risk_score: r.default_risk_score,
      unit: r.unit_number || null,
      project: r.project || null,
    })),
    credit_score_distribution: creditDistribution,
    agent_action_summary_last_7_days: agentSummary,
    // Already-derived, plain-English sentences (Section 3) — handed
    // straight through rather than the raw breakdown, since the assistant
    // needs "what works", not a second copy of that analysis to redo itself.
    communication_insights: communicationEffectiveness ? outcomes.deriveTopInsights(communicationEffectiveness) : [],
    recovery_playbook_summary: (playbook || [])
      .filter((s) => s.has_enough_data)
      .map((s) => ({ stage: s.escalation_label, recovery_rate: s.recovery_rate, best_channel: s.best_channel })),
  };
}

// ── Category-specific context — added on top of the base above ───────────
async function gatherCategoryContext(orgId, category, tokenizer) {
  if (category === 'collections') {
    const { data } = await supabaseAdmin
      .from('re_payments')
      .select('amount, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(re_units!inner(re_projects(name)))))')
      .eq('organization_id', orgId)
      .is('voided_at', null)
      .gte('paid_at', `${lagosToday().slice(0, 7)}-01`);
    const byProject = new Map();
    for (const row of data || []) {
      const name = row.re_installment_schedule?.re_installment_plans?.re_reservations?.re_units?.re_projects?.name || 'Unassigned';
      byProject.set(name, round2((byProject.get(name) || 0) + Number(row.amount || 0)));
    }
    return { collections_by_project_this_month: Object.fromEntries(byProject) };
  }

  if (category === 'buyers') {
    const { data } = await supabaseAdmin
      .from('re_customers')
      .select('id, full_name, credit_score')
      .eq('organization_id', orgId)
      .order('credit_score', { ascending: true })
      .limit(15);
    return {
      lowest_credit_score_buyers: (data || []).map((c) => ({
        customer_ref: tokenizer.refFor(c.id, c.full_name), credit_score: c.credit_score,
      })),
    };
  }

  if (category === 'projects') {
    const { data } = await supabaseAdmin
      .from('re_project_health')
      .select('health_score, re_projects(name)')
      .eq('organization_id', orgId)
      .eq('computed_date', lagosToday());
    return {
      project_health_scores: (data || []).map((p) => ({ project: p.re_projects?.name, health_score: p.health_score })),
    };
  }

  if (category === 'sales') {
    const rows = await commissions.leaderboard(orgId);
    return {
      rep_leaderboard: rows.slice(0, 10).map((r) => ({
        rep_name: r.name, deals_closed: r.deals_closed, total_collected: r.total_collected,
        collection_rate: r.collection_rate, commission_earned: r.commission_earned,
      })),
    };
  }

  if (category === 'documents') {
    const rows = await fetchAllForContext('re_documents', 'status', orgId);
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    return { document_status_breakdown: byStatus };
  }

  // executive — the full snapshot, one call each, already narrow by design.
  const [collections, buyers, projects, sales] = await Promise.all([
    gatherCategoryContext(orgId, 'collections', tokenizer),
    gatherCategoryContext(orgId, 'buyers', tokenizer),
    gatherCategoryContext(orgId, 'projects', tokenizer),
    gatherCategoryContext(orgId, 'sales', tokenizer),
  ]);
  return { ...collections, ...buyers, ...projects, ...sales };
}

const SYSTEM_PROMPT =
  'You are Archta Intelligence, a business analytics assistant for a Nigerian property developer. ' +
  'You have access to real operational data for this workspace, provided below as JSON. Answer questions ' +
  'directly using that data. Be specific with numbers — always use actual figures from the context, never ' +
  'generic answers. Format amounts in Nigerian naira with the ₦ symbol. When collections drop, explain exactly ' +
  'which project or buyer segment drove the change using the data given. When asked about risk, name specific ' +
  'buyers using their customer_ref token exactly as given (e.g. "BUYER_3") — it is replaced with their real name ' +
  'automatically before anyone reads your answer, so never invent a name and never write out a real name yourself. ' +
  'When asked for recommendations, give actionable steps a collections officer can take today. Keep answers ' +
  'concise — 3 to 5 sentences unless asked to elaborate. Never make up a number, a buyer, a project or a trend — ' +
  'if the context below does not contain the answer, say so plainly rather than guessing. Prior conversation ' +
  'turns are provided for continuity only — they may be stale or incomplete; the CONTEXT DATA below is always ' +
  'the current source of truth and overrides anything a prior turn seemed to say. Present recommendations as ' +
  'recommendations, never as guaranteed outcomes. If completed_project_history is present, its key_metrics are ' +
  'verified figures computed directly from that project\'s recorded history — state them as fact. Its summary ' +
  'field is an EARLIER AI-generated narrative interpretation of the same project, not a verified record — when ' +
  'you draw on it, make clear you are relaying a prior summary, not restating a confirmed fact. ' +
  'CONFIDENCE BLOCK: when your answer is grounded in quantifiable data from the context (a count, a total, a ' +
  'rate, a trend), end your reply with a single-line JSON object, on its own line, after all prose, in exactly ' +
  'this shape: {"confidence": "high"|"medium"|"low", "sample_size": <integer count of records the answer is ' +
  'based on>, "date_range": "<e.g. 30 days>", "caveat": "<optional short warning, or omit the field entirely>"}. ' +
  'confidence reflects how much data actually supports the answer, not how confident your prose sounds — few ' +
  'records or a narrow date range means low or medium, never high. Do not wrap it in a code fence, do not label ' +
  'it, and do not mention this JSON block anywhere in the prose above it. If the answer is not grounded in ' +
  'quantifiable data at all (a definitional question, a request for general advice), omit the block entirely.';

// Below this many supporting records, a caveat is enforced regardless of
// whether the model remembered to add one.
const MIN_CONFIDENT_SAMPLE_SIZE = 5;
const LIMITED_DATA_CAVEAT = 'Limited data — this insight will improve as more operational history accumulates.';

// Extracts the trailing confidence JSON block the system prompt asks the
// model for, and returns the answer text with it stripped out — the block
// is metadata about the answer, never part of what the user reads (item 2's
// own "not as part of the answer text"). Defensive by necessity: this is
// free-text model output, not a structured response_format the way
// aiBrief.js's own OpenAI call uses, so a model that forgets the block, mis-
// formats it, or wraps it in a code fence must degrade to "no evidence"
// rather than corrupting the visible answer.
function extractConfidenceBlock(rawText) {
  const text = String(rawText || '').trim();
  const lastBrace = text.lastIndexOf('{');
  if (lastBrace === -1) return { answer: text, confidence: null };

  // Strip a trailing code fence the model sometimes wraps the block in
  // despite being asked not to.
  const candidate = text.slice(lastBrace).replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { answer: text, confidence: null };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.confidence) return { answer: text, confidence: null };

  const answerWithoutBlock = text.slice(0, lastBrace).replace(/```(?:json)?\s*$/i, '').trim();
  const sampleSize = Number.isFinite(Number(parsed.sample_size)) ? Number(parsed.sample_size) : null;
  let caveat = parsed.caveat ? String(parsed.caveat).slice(0, 300) : null;
  // Deterministic, not trusted to the model: a caveat on thin data must
  // always be present, not merely whenever the model remembered to add one.
  if (sampleSize != null && sampleSize < MIN_CONFIDENT_SAMPLE_SIZE && !caveat) {
    caveat = LIMITED_DATA_CAVEAT;
  }

  return {
    // Never leave an empty bubble if the model's whole reply was the JSON
    // block with no prose above it.
    answer: answerWithoutBlock || text,
    confidence: {
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : null,
      sample_size: sampleSize,
      date_range: parsed.date_range ? String(parsed.date_range).slice(0, 100) : null,
      caveat,
    },
  };
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

async function requestAnswerFromModel(question, context, history) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-MAX_CONVERSATION_HISTORY).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) })),
    { role: 'user', content: `CONTEXT DATA (JSON):\n${JSON.stringify(context)}\n\nQUESTION: ${question}` },
  ];

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ model: MODEL, messages }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI ${response.status}: ${detail.slice(0, 200)}`);
  }
  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new Error('OpenAI returned an empty answer'), { malformedResponse: true });
  return { text: content, tokensUsed: json.usage?.total_tokens || null };
}

// No model reachable — the same "the product does not go silent" rule
// aiBrief's own fallback follows, answered from the exact same context
// object the model would have read, just without the model's own prose
// stitching it together.
function buildFallbackAnswer(context) {
  const lines = [
    `Collections this month: ${naira(context.collections.this_month)} (last month: ${naira(context.collections.last_month)}).`,
    `Overdue: ${naira(context.overdue.total_amount)} across ${context.overdue.buyer_count} buyer(s).`,
  ];
  if (context.top_defaulting_buyers?.length) {
    lines.push(`Highest default risk: ${context.top_defaulting_buyers[0].customer_ref} (score ${context.top_defaulting_buyers[0].default_risk_score}).`);
  }
  lines.push('The AI model was unavailable, so this is a direct read of the current numbers rather than a written answer — try asking again shortly for a fuller response.');
  return lines.join(' ');
}

async function askAssistant(orgId, userId, question, conversationHistory = []) {
  const tokenizer = createRefTokenizer();
  const category = detectQuestionCategory(question);
  // Lazy require — projectSummaryService itself requires this file (for
  // createRefTokenizer/resolveRefsInText), so a top-level require here
  // would be a circular one; deferred to call time, the same "avoid the two
  // modules referencing each other at load time" reasoning documentService.
  // generateDocument's own lazy require of receiptService already uses.
  const projectSummaries = require('./projectSummaryService');
  const [base, categoryContext, mentionedProjects] = await Promise.all([
    gatherBaseContext(orgId, tokenizer),
    gatherCategoryContext(orgId, category, tokenizer),
    // SECTION 8 (feature expansion) — institutional memory. A question
    // naming a completed project by name gets that project's own AI-
    // generated summary folded in, so "What happened with Project A?"
    // has real history to answer from rather than just this month's
    // snapshot. Never throws the whole request over a lookup that found
    // nothing relevant to add.
    projectSummaries.findMentionedProjectSummaries(orgId, question).catch(() => []),
  ]);
  const context = { ...base, ...categoryContext, question_category: category };
  if (mentionedProjects.length) context.completed_project_history = mentionedProjects;

  let answerText = null;
  let tokensUsed = null;
  let generatedBy = 'model';
  let lastError = null;
  // AUDIT FIX (FE2) — 'not_configured' (no OPENAI_API_KEY at all — a
  // permanent, admin-fixable state) vs 'model_error' (the key is there but
  // every retry against OpenAI itself failed — a transient state worth a
  // "try again"). Both used to collapse into the same generated_by:
  // 'fallback' with nothing in the response telling the frontend which one
  // it was looking at.
  let fallbackReason = null;

  if (env.openai.apiKey) {
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      if (RETRY_DELAYS_MS[attempt]) await sleep(RETRY_DELAYS_MS[attempt]);
      try {
        const result = await requestAnswerFromModel(question, context, conversationHistory);
        answerText = result.text;
        tokensUsed = result.tokensUsed;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) break;
        console.warn(`[ai-assistant] model attempt ${attempt + 1}/${RETRY_DELAYS_MS.length} failed:`, err.message);
      }
    }
  } else {
    lastError = new Error('OPENAI_API_KEY not configured');
    fallbackReason = 'not_configured';
  }

  if (lastError || !answerText) {
    console.warn('[ai-assistant] falling back to a direct data readout:', lastError?.message);
    answerText = buildFallbackAnswer(context);
    generatedBy = 'fallback';
    if (!fallbackReason) fallbackReason = 'model_error';
  }

  // CONFIDENCE AND EVIDENCE DISPLAY — stripped from the model's raw reply
  // BEFORE ref-resolution and storage, so BUYER_N tokens are only ever
  // resolved (and only the visible prose is ever stored/shown) — the block
  // itself is never real prose to resolve refs in. A fallback answer's
  // deterministic prose never contains one, so this naturally no-ops
  // (confidence stays null) for that path without a separate branch.
  const { answer: answerWithoutConfidence, confidence } = extractConfidenceBlock(answerText);
  const resolvedAnswer = resolveRefsInText(answerWithoutConfidence, tokenizer.nameByRef);

  // RECOMMENDATION FEEDBACK — the inserted row's own id is returned to the
  // caller as conversation_id so a later POST /ai/feedback vote can be
  // traced back to the exact context/model/category that produced it,
  // rather than only to whatever question/answer text the client still has.
  let conversationId = null;
  try {
    const { data: inserted, error: insertError } = await supabaseAdmin.from('re_ai_conversations').insert({
      organization_id: orgId,
      user_id: userId,
      question: String(question).slice(0, 2000),
      answer: resolvedAnswer.slice(0, 5000),
      question_category: category,
      context_snapshot: context,
      tokens_used: tokensUsed,
      generated_by: generatedBy,
    }).select('id').single();
    if (insertError) throw insertError;
    conversationId = inserted.id;
  } catch (err) {
    // A logging failure must not cost the person waiting on this answer —
    // conversationId simply stays null, same as it always was before this
    // feature existed.
    console.warn('[ai-assistant] could not store conversation:', err.message);
  }

  return {
    answer: resolvedAnswer, category, generated_by: generatedBy, fallback_reason: fallbackReason,
    conversation_id: conversationId, confidence,
  };
}

// RECOMMENDATION FEEDBACK — POST /ai/feedback (routes/ai.js), which
// validates feedback/question/answer BEFORE calling this, same "validate in
// the route, assume valid input here" convention askAssistant's own caller
// already follows for `question`. This function itself never throws: a vote
// that failed to record must not read as an error to whoever just clicked a
// thumbs-up/down button, same "instrumentation must not cost the real
// action" rule this file's own conversation-logging above follows.
async function submitFeedback(orgId, userId, { conversationId = null, question, answer, feedback }) {
  try {
    const { error } = await supabaseAdmin.from('re_ai_feedback').insert({
      organization_id: orgId,
      user_id: userId,
      conversation_id: conversationId || null,
      question: String(question).slice(0, 2000),
      answer: String(answer).slice(0, 5000),
      feedback,
    });
    if (error) throw error;
    return { recorded: true };
  } catch (err) {
    console.warn('[ai-assistant] could not record feedback:', err.message);
    return { recorded: false };
  }
}

// ── Proactive insights ─────────────────────────────────────────────────
// jobs/daily.js, once per org per day, AFTER that org's brief has been
// generated — reusing overdueAlerts.notifyOverdue's OWN already-computed
// new_overdue count (passed in) rather than re-querying "who became
// overdue today" a second time in the same morning pass.
//
// "A previously high credit score buyer just missed their first payment":
// credit_score's own default_history dimension (creditScoreService.js)
// already penalizes any PRIOR late/overdue event, so a buyer who is still
// scored HIGH_CREDIT_THRESHOLD+ despite an installment overdue as of today
// has, by construction, no material default history yet — this reads as
// "their first real miss" without a second query re-deriving what
// credit_score already encodes.
const COLLECTIONS_DROP_THRESHOLD = 0.15;
const PROJECT_HEALTH_THRESHOLD = 60; // matches projectHealthService.CRITICAL_THRESHOLD
const NEW_OVERDUE_SURGE_THRESHOLD = 5;
const HIGH_CREDIT_THRESHOLD = 80; // matches creditScoreService's "excellent" tier floor

async function sameDayMonthOverMonthCollections(orgId) {
  const today = lagosToday();
  const dayOfMonth = Number(today.slice(8, 10));
  const thisMonthStart = `${today.slice(0, 7)}-01`;
  const lastMonthDate = new Date(`${thisMonthStart}T00:00:00Z`);
  lastMonthDate.setUTCMonth(lastMonthDate.getUTCMonth() - 1);
  const lastMonthStart = lastMonthDate.toISOString().slice(0, 7) + '-01';
  const lastMonthSameDay = new Date(Date.parse(lastMonthStart) + (dayOfMonth - 1) * 86_400_000).toISOString().slice(0, 10);

  const [{ data: thisMonth }, { data: lastMonth }] = await Promise.all([
    supabaseAdmin.from('re_payments').select('amount').eq('organization_id', orgId)
      .gte('paid_at', thisMonthStart).is('voided_at', null),
    supabaseAdmin.from('re_payments').select('amount').eq('organization_id', orgId)
      .gte('paid_at', lastMonthStart).lte('paid_at', lastMonthSameDay).is('voided_at', null),
  ]);
  return {
    this_month_to_date: round2((thisMonth || []).reduce((s, p) => s + Number(p.amount || 0), 0)),
    last_month_same_point: round2((lastMonth || []).reduce((s, p) => s + Number(p.amount || 0), 0)),
  };
}

async function findNewHighScoreDefaulters(orgId) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const { data } = await supabaseAdmin
    .from('re_installment_schedule')
    .select(`due_date, re_installment_plans!inner(re_reservations!inner(
      re_customers!inner(id, full_name, credit_score)))`)
    .eq('organization_id', orgId)
    .eq('status', 'overdue')
    .eq('due_date', yesterday);

  const seen = new Map();
  for (const row of data || []) {
    const customer = row.re_installment_plans?.re_reservations?.re_customers;
    if (customer && (customer.credit_score || 0) >= HIGH_CREDIT_THRESHOLD) seen.set(customer.id, customer.full_name);
  }
  return [...seen.values()];
}

// Returns the insight filed, or null if nothing crossed a threshold today
// (the common case — most days are quiet, and a quiet day files nothing).
// alreadyFiledToday guards against calling this twice for the same org on
// the same date (jobs/daily.js's own per-run dedup, checked by the caller).
async function checkProactiveInsights(orgId, { newOverdueCount = 0 } = {}) {
  const [collectionsComparison, criticalProjects, newHighScoreDefaulters] = await Promise.all([
    sameDayMonthOverMonthCollections(orgId),
    projectHealth.criticalProjects(orgId),
    findNewHighScoreDefaulters(orgId),
  ]);

  let trigger = null;
  let message = null;
  let question = null;

  const { this_month_to_date: thisMonth, last_month_same_point: lastMonth } = collectionsComparison;
  const drop = lastMonth > 0 ? (lastMonth - thisMonth) / lastMonth : 0;
  if (drop >= COLLECTIONS_DROP_THRESHOLD) {
    trigger = 'collections_drop';
    const pct = Math.round(drop * 100);
    message = `Collections are down ${pct}% this month so far. Tap to find out why.`;
    question = 'Why did collections drop this month?';
  } else if (criticalProjects?.length) {
    trigger = 'project_health_drop';
    message = `${criticalProjects[0].re_projects?.name || 'A project'}'s health score has dropped to ${criticalProjects[0].health_score}. Tap to find out why.`;
    question = 'Which project is performing worst right now and why?';
  } else if (newOverdueCount > NEW_OVERDUE_SURGE_THRESHOLD) {
    trigger = 'new_overdue_surge';
    message = `${newOverdueCount} buyers became overdue today. Tap for a breakdown.`;
    question = 'Which buyers just became overdue today?';
  } else if (newHighScoreDefaulters.length) {
    trigger = 'high_score_buyer_missed_payment';
    message = `${newHighScoreDefaulters[0]} has an excellent credit history but just missed a payment. Tap for details.`;
    question = `Which buyers are most likely to default?`;
  }

  if (!trigger) return null;

  const { data, error } = await supabaseAdmin
    .from('re_ai_proactive_insights')
    .insert({ organization_id: orgId, message, question, trigger_reason: trigger })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  CATEGORIES,
  detectQuestionCategory,
  gatherBaseContext,
  gatherCategoryContext,
  buildFallbackAnswer,
  askAssistant,
  resolveRefsInText,
  // Exported for projectSummaryService (SECTION 8 — feature expansion): the
  // exact same buyer-name ref/resolve mechanism this file's own header
  // establishes, reused rather than a second implementation of the same
  // privacy boundary.
  createRefTokenizer,
  checkProactiveInsights,
  COLLECTIONS_DROP_THRESHOLD,
  PROJECT_HEALTH_THRESHOLD,
  NEW_OVERDUE_SURGE_THRESHOLD,
  HIGH_CREDIT_THRESHOLD,
  submitFeedback,
  // Exported for logic.test.js — pure, no database, directly unit-testable.
  extractConfidenceBlock,
};
