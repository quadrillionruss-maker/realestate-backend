// aiBrief.js — the "Sales Operations Manager", v1's single AI worker.
//
// Reads the org's state each morning, asks the model for a structured brief,
// stores it, and files the recommended follow-ups as tasks (source: 'ai').
// Everything it produces is a PROPOSAL: it drafts messages, it never sends
// them. That boundary is what makes the Deal Manager upgrade in
// docs/AI_WORKFORCE.md a change of permissions rather than a rewrite.
//
// Talks to OpenAI over fetch — no SDK dependency to install, and one less
// package to keep current for a single HTTP call.

const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday } = require('./overdueService');
const { openAndBrokenForBrief } = require('./promiseService');
const { describeStage } = require('./escalationService');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// Sourced from config rather than read here, so the default lives in exactly
// one place (src/config/env.js) and OPENAI_BRIEF_MODEL overrides it per
// environment. It used to be defaulted in both files, which meant changing the
// model in one left a stale value in the other.
const MODEL = env.openai.briefModel;
const REQUEST_TIMEOUT_MS = 45_000;

const BRIEF_SCHEMA = {
  name: 'daily_brief',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'risks', 'follow_ups', 'recommendations'],
    properties: {
      summary: { type: 'string', description: '3-5 sentence morning summary for the developer/CEO' },
      risks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['customer_name', 'reason', 'severity'],
          properties: {
            customer_name: { type: 'string' },
            reason: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
        },
      },
      follow_ups: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['customer_name', 'reservation_id', 'whatsapp_draft', 'email_subject', 'email_draft'],
          properties: {
            customer_name: { type: 'string' },
            reservation_id: { type: ['string', 'null'] },
            whatsapp_draft: { type: 'string', description: 'Short, warm, Nigerian business tone. Naira amounts formatted with ₦ and commas.' },
            email_subject: { type: 'string' },
            email_draft: { type: 'string' },
          },
        },
      },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'reservation_id'],
          properties: {
            title: { type: 'string', description: 'Actionable task, e.g. "Call Mrs Adeyemi about 2 missed installments"' },
            reservation_id: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
};

const naira = (amount) =>
  '₦' + Number(amount || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });

const daysBetween = (fromISO, toISO) =>
  Math.max(0, Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000));

// ── State gathering ────────────────────────────────────────────────────────
// Filters on the schedule's OWN organization_id rather than reaching through
// the join. That column is denormalized precisely so org scoping never depends
// on a nested filter path staying correct.
async function gatherOrgState(orgId) {
  const today = lagosToday();
  const in7 = new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10);

  const scheduleSelect = `
    id, due_date, amount_due, status,
    re_installment_plans!inner(
      id, reservation_id,
      re_reservations!inner(
        id, escalation_stage,
        re_customers(id, full_name, phone, email),
        re_units(unit_number, re_projects(name))
      )
    )`;

  const [overdue, upcoming, documents, promises] = await Promise.all([
    supabaseAdmin
      .from('re_installment_schedule')
      .select(scheduleSelect)
      .eq('organization_id', orgId)
      .eq('status', 'overdue')
      .order('due_date', { ascending: true }),
    supabaseAdmin
      .from('re_installment_schedule')
      .select(scheduleSelect)
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .gte('due_date', today)
      .lte('due_date', in7)
      .order('due_date', { ascending: true }),
    supabaseAdmin
      .from('re_documents')
      .select('id, doc_type, status, reservation_id, re_reservations(re_customers(full_name), re_units(unit_number))')
      .eq('organization_id', orgId)
      .eq('status', 'pending'),
    // What buyers said they would do. "Promised the 15th, still nothing" is a
    // sharper line than "overdue since the 1st", because the buyer chose the
    // date themselves and the model can say so.
    openAndBrokenForBrief(orgId).catch((err) => {
      console.warn('[re-brief] could not read promises:', err.message);
      return [];
    }),
  ]);

  // Flatten the join shape into something compact enough to put in a prompt
  // without spending tokens on Supabase's nesting.
  const flatten = (rows) => (rows || []).map((row) => {
    const reservation = row.re_installment_plans?.re_reservations || {};
    const customer = reservation.re_customers || {};
    const unit = reservation.re_units || {};
    return {
      schedule_id: row.id,
      reservation_id: reservation.id || null,
      customer_name: customer.full_name || 'Unknown buyer',
      customer_phone: customer.phone || null,
      customer_email: customer.email || null,
      project: unit.re_projects?.name || null,
      unit_number: unit.unit_number || null,
      due_date: row.due_date,
      amount: Number(row.amount_due),
      days_late: row.status === 'overdue' ? daysBetween(row.due_date, today) : 0,
      // The tone this buyer should be written to. One missed installment and
      // five are the same word ("overdue") without it, and the model happily
      // writes the same warm nudge to both.
      escalation_stage: reservation.escalation_stage || 'none',
    };
  });

  return {
    today,
    overdue: flatten(overdue.data),
    upcomingWeek: flatten(upcoming.data),
    promises: promises || [],
    pendingDocuments: (documents.data || []).map((d) => ({
      id: d.id,
      doc_type: d.doc_type,
      reservation_id: d.reservation_id,
      customer_name: d.re_reservations?.re_customers?.full_name || null,
      unit_number: d.re_reservations?.re_units?.unit_number || null,
    })),
  };
}

// ── Rule-based brief ───────────────────────────────────────────────────────
// Used when there is nothing to report, when OPENAI_API_KEY is absent, and
// when the model call fails. A developer who opens the app at 7am gets the
// numbers and a usable draft either way — the AI improves the wording, it
// isn't load-bearing for the operational facts.
function buildFallbackBrief(state) {
  // Promises are keyed by buyer name, which is what the overdue rows carry.
  // Absent entirely on older callers (and in the offline fixtures), hence the
  // default — this function has to keep working on a state object that
  // predates the feature.
  const promiseByCustomer = new Map();
  for (const promise of state.promises || []) {
    const existing = promiseByCustomer.get(promise.customer_name);
    // A broken promise is the more useful of the two to surface.
    if (!existing || promise.status === 'broken') promiseByCustomer.set(promise.customer_name, promise);
  }

  const byCustomer = new Map();
  for (const row of state.overdue) {
    const key = row.customer_name;
    const entry = byCustomer.get(key) || {
      customer_name: key,
      reservation_id: row.reservation_id,
      project: row.project,
      unit_number: row.unit_number,
      count: 0,
      amount: 0,
      max_days_late: 0,
      escalation_stage: row.escalation_stage || null,
    };
    entry.count += 1;
    entry.amount += row.amount;
    entry.max_days_late = Math.max(entry.max_days_late, row.days_late);
    if (row.escalation_stage && row.escalation_stage !== 'none') entry.escalation_stage = row.escalation_stage;
    byCustomer.set(key, entry);
  }

  // Attach the promise and settle each buyer's stage. Where the reservation
  // has no stage recorded yet (an import, or a sweep that has not run), it is
  // derived from the missed-installment count using the same thresholds, so
  // the wording is never harsher than the data justifies.
  const behind = [...byCustomer.values()].map((c) => ({
    ...c,
    promise: promiseByCustomer.get(c.customer_name) || null,
    stage: describeStage(c.escalation_stage || stageKeyForCount(c.count)),
  })).sort((a, b) => b.amount - a.amount);

  const brokenPromises = behind.filter((c) => c.promise?.status === 'broken');
  const overdueTotal = state.overdue.reduce((sum, r) => sum + r.amount, 0);
  const upcomingTotal = state.upcomingWeek.reduce((sum, r) => sum + r.amount, 0);

  const sentences = [];
  if (behind.length) {
    sentences.push(
      `${behind.length} buyer${behind.length > 1 ? 's are' : ' is'} behind on ${naira(overdueTotal)} across ${state.overdue.length} installment${state.overdue.length > 1 ? 's' : ''}.`
    );
  } else {
    sentences.push('No overdue installments today.');
  }
  if (state.upcomingWeek.length) {
    sentences.push(`${state.upcomingWeek.length} payment${state.upcomingWeek.length > 1 ? 's' : ''} totalling ${naira(upcomingTotal)} fall${state.upcomingWeek.length > 1 ? '' : 's'} due in the next 7 days.`);
  }
  if (brokenPromises.length) {
    sentences.push(`${brokenPromises.length} buyer${brokenPromises.length > 1 ? 's have' : ' has'} broken a promise to pay.`);
  }
  if (state.pendingDocuments.length) {
    sentences.push(`${state.pendingDocuments.length} document${state.pendingDocuments.length > 1 ? 's are' : ' is'} still waiting to be issued.`);
  }
  if (behind.length) {
    // A broken promise jumps the queue over a bigger number: the buyer named
    // the date themselves, so it is the call most likely to go somewhere.
    const first = brokenPromises[0] || behind[0];
    sentences.push(`Start with ${first.customer_name} — ${naira(first.amount)}, ${first.max_days_late} day${first.max_days_late === 1 ? '' : 's'} late.`);
  }

  return {
    summary: sentences.join(' '),
    risks: behind.map((c) => ({
      customer_name: c.customer_name,
      reason: `${c.count} missed installment${c.count > 1 ? 's' : ''} totalling ${naira(c.amount)}, oldest ${c.max_days_late} day${c.max_days_late === 1 ? '' : 's'} late`
        + (c.promise?.status === 'broken' ? `; promised to pay by ${c.promise.promised_date} and did not` : '')
        + (c.promise?.status === 'open' ? `; promised to pay by ${c.promise.promised_date}` : ''),
      severity: severityFor(c),
    })),
    // Nobody at legal stage gets a drafted message. Anything written to a
    // buyer whose file is with a lawyer can be read back in court, and that
    // is not a sentence an automated draft should be composing.
    follow_ups: behind.filter((c) => c.stage.key !== 'legal').slice(0, 10).map((c) => ({
      customer_name: c.customer_name,
      reservation_id: c.reservation_id,
      whatsapp_draft: draftFor(c),
      email_subject: c.stage.key === 'reminder'
        ? `Outstanding installment — ${c.unit_number ? `Unit ${c.unit_number}` : 'your allocation'}`
        : `Arrears notice — ${c.unit_number ? `Unit ${c.unit_number}` : 'your allocation'}`,
      email_draft: emailFor(c),
    })),
    recommendations: behind.slice(0, 5).map((c) => ({
      title: c.stage.key === 'legal'
        ? `Refer ${c.customer_name} to legal review — ${c.count} missed installments (${naira(c.amount)})`
        : c.promise?.status === 'broken'
          ? `Call ${c.customer_name} — broke a promise to pay by ${c.promise.promised_date} (${naira(c.amount)})`
          : `Call ${c.customer_name} about ${c.count} missed installment${c.count > 1 ? 's' : ''} (${naira(c.amount)})`,
      reservation_id: c.reservation_id,
    })),
  };
}

// Same thresholds as escalationService, applied to a buyer whose reservation
// has no stage recorded yet.
const stageKeyForCount = (count) =>
  count >= 7 ? 'legal' : count >= 5 ? 'final_notice' : count >= 3 ? 'formal_notice' : count >= 1 ? 'reminder' : 'none';

function severityFor(c) {
  // A broken promise is worse than the same arrears without one: the buyer
  // was asked, gave a date, and let it pass.
  if (c.promise?.status === 'broken') return 'high';
  if (c.count >= 3 || c.max_days_late > 60) return 'high';
  if (c.count >= 2 || c.max_days_late > 30) return 'medium';
  return 'low';
}

const where = (c) =>
  `${c.unit_number ? `Unit ${c.unit_number}` : 'your unit'}${c.project ? ` at ${c.project}` : ''}`;

function draftFor(c) {
  if (c.promise?.status === 'broken') {
    return `Good morning ${c.customer_name}. We spoke about ${where(c)} and understood payment would come through by `
      + `${c.promise.promised_date}. We have not seen it yet — is there anything holding it up? `
      + `${naira(c.amount)} is currently outstanding. Do let us know a date that works and we will note it. Thank you.`;
  }

  if (c.stage.key === 'final_notice') {
    return `Dear ${c.customer_name}, our records show ${naira(c.amount)} outstanding across ${c.count} installments on `
      + `${where(c)}. Under the terms of your Contract of Sale, continued arrears place this allocation at risk. `
      + `Please contact us before the end of this week to settle the balance or agree a revised schedule.`;
  }

  if (c.stage.key === 'formal_notice') {
    return `Dear ${c.customer_name}, this is a formal reminder that ${naira(c.amount)} is outstanding across `
      + `${c.count} installments on ${where(c)}, as scheduled in your Contract of Sale. `
      + `Kindly confirm a specific date on which we should expect payment, or contact us to discuss the schedule.`;
  }

  return `Good morning ${c.customer_name}, this is a gentle reminder from the sales team regarding ${where(c)}. `
    + `We have ${naira(c.amount)} outstanding on your payment plan. `
    + `Kindly let us know when we should expect it, or reply here if you would like to discuss the schedule. Thank you.`;
}

function emailFor(c) {
  const opening = c.stage.key === 'reminder'
    ? 'We hope this message finds you well. Our records show'
    : 'Our records show';

  const body = `Dear ${c.customer_name},\n\n`
    + `${opening} ${naira(c.amount)} outstanding across ${c.count} installment${c.count > 1 ? 's' : ''} on ${where(c)}.\n\n`
    + (c.promise?.status === 'broken'
      ? `We understood from our last conversation that payment would be made by ${c.promise.promised_date}.\n\n`
      : '')
    + (c.stage.key === 'final_notice'
      ? 'Under the terms of your Contract of Sale, continued arrears place this allocation at risk. Please settle the balance or contact us to agree a revised schedule before the end of this week.\n\n'
      : 'Please let us know when we can expect payment, or contact us if you would like to review the schedule.\n\n');

  return `${body}Kind regards,\nSales Team`;
}

// ── Model call ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Worth trying again: a timeout, a dropped connection, a rate limit, or any 5xx.
// Not worth trying again: a malformed request or a rejected key.
function isRetryable(err) {
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const status = Number((/OpenAI (\d{3})/.exec(err.message) || [])[1] || 0);
  if (!status) return true;          // network-level failure, no status to read
  if (status === 429) return true;   // rate limited
  return status >= 500;
}

async function requestBriefFromModel(state) {
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_schema', json_schema: BRIEF_SCHEMA },
      messages: [
        {
          role: 'system',
          content:
            'You are the Sales Operations Manager for a Nigerian real estate developer. ' +
            'You write a concise morning brief for the MD/CEO. Currency is Naira (₦). ' +
            'Only reference customers present in the data, never invent names, amounts or dates. ' +
            'Use reservation_id values exactly as given.\n\n' +
            // Without this the model writes one tone for everybody: the same
            // warm nudge to a buyer one week late and to one eight months in
            // arrears. Both are wrong, and expensively so.
            'MATCH THE TONE TO escalation_stage on each overdue row:\n' +
            '- reminder: warm and brief, under 80 words. Assume they forgot. No consequences mentioned.\n' +
            '- formal_notice: polite but formal. Reference the Contract of Sale and the arrears total. Ask for a specific date.\n' +
            '- final_notice: formal and direct. State that the allocation is at risk under the contract. Request settlement or a revised plan by a stated date.\n' +
            '- legal: do NOT write a follow_up for this buyer at all. Add a recommendation to refer the file to the legal team.\n\n' +
            'These are valued installment customers, not debtors — never threaten, never use the word "debt", ' +
            'and never state a consequence the contract does not provide for.\n\n' +
            'The `promises` array is what buyers themselves said they would do. A buyer with a status:"broken" ' +
            'promise should be high severity and appear first: they named the date, not us. Reference it directly ' +
            '("we understood payment would come through by the 15th"), and never repeat a due date they have ' +
            'already acknowledged as though they had not.',
        },
        {
          role: 'user',
          content: `Today is ${state.today} (Africa/Lagos). Current state:\n${JSON.stringify(state, null, 2)}`,
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
  if (!content) throw new Error('OpenAI returned an empty brief');
  return JSON.parse(content);
}

// ── Orchestration ──────────────────────────────────────────────────────────
async function generateDailyBrief(orgId) {
  const state = await gatherOrgState(orgId);
  const nothingToReport =
    !state.overdue.length && !state.upcomingWeek.length && !state.pendingDocuments.length;

  // A quiet day is a fact, not a prompt. Don't spend a call restating it.
  if (nothingToReport) {
    const quiet = {
      summary: 'All clear today: no overdue installments, no payments due this week, no documents pending.',
      risks: [],
      follow_ups: [],
      recommendations: [],
    };
    await storeBrief(orgId, quiet, 'fallback');
    return { ...quiet, generated_by: 'fallback' };
  }

  let brief;
  let generatedBy = 'ai';

  if (!process.env.OPENAI_API_KEY) {
    brief = buildFallbackBrief(state);
    generatedBy = 'fallback';
  } else {
    // Three attempts with backoff before giving up on the model.
    //
    // A single timeout at 07:00 used to cost the whole morning's wording, and
    // the common failures here are the transient ones — a rate limit, a cold
    // connection, a 503 — which a second attempt four seconds later usually
    // clears. Retrying is much cheaper than a CEO reading a rule-based brief.
    //
    // A 4xx that is not 429 is not retried: a bad request or a rejected key
    // will fail identically three times and only delay the fallback.
    const delays = [0, 4_000, 12_000];
    let lastError = null;

    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await sleep(delays[attempt]);
      try {
        brief = await requestBriefFromModel(state);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) {
          console.error('[re-brief] model call failed permanently:', err.message);
          break;
        }
        console.warn(`[re-brief] model attempt ${attempt + 1}/${delays.length} failed:`, err.message);
      }
    }

    if (lastError || !brief) {
      // The brief is the product's daily heartbeat — a model outage degrades
      // the wording, it does not skip the morning. `generated_by: 'fallback'`
      // is what makes the degradation visible on the dashboard rather than
      // silent, and `model_error` records why for the activity log.
      console.error('[re-brief] falling back to the rule-based brief');
      brief = buildFallbackBrief(state);
      brief.model_error = lastError ? String(lastError.message).slice(0, 300) : 'unknown';
      generatedBy = 'fallback';
    }
  }

  await storeBrief(orgId, brief, generatedBy);
  await fileRecommendationsAsTasks(orgId, brief.recommendations);

  return { ...brief, generated_by: generatedBy };
}

async function storeBrief(orgId, brief, generatedBy) {
  const { error } = await supabaseAdmin.from('re_ai_briefs').upsert(
    {
      organization_id: orgId,
      brief_date: lagosToday(),
      summary: brief.summary,
      payload: brief,
      generated_by: generatedBy,
    },
    { onConflict: 'organization_id,brief_date' }
  );
  if (error) throw error;
}

// Recommendations become real tasks so the CEO works one list, not two.
// Re-running the brief must not multiply them, hence the title check.
async function fileRecommendationsAsTasks(orgId, recommendations = []) {
  for (const rec of recommendations) {
    if (!rec?.title) continue;

    const { data: duplicate } = await supabaseAdmin
      .from('re_tasks')
      .select('id')
      .eq('organization_id', orgId)
      .eq('title', rec.title)
      .eq('status', 'open')
      .eq('source', 'ai')
      .limit(1)
      .maybeSingle();

    if (duplicate) continue;

    const { error } = await supabaseAdmin.from('re_tasks').insert({
      organization_id: orgId,
      title: rec.title,
      related_reservation_id: rec.reservation_id || null,
      source: 'ai',
    });
    if (error) console.error('[re-brief] could not file task:', error.message);
  }
}

module.exports = { generateDailyBrief, gatherOrgState, buildFallbackBrief };
