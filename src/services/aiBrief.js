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

const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday } = require('./overdueService');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_BRIEF_MODEL || 'gpt-4o';
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
        id,
        re_customers(id, full_name, phone, email),
        re_units(unit_number, re_projects(name))
      )
    )`;

  const [overdue, upcoming, documents] = await Promise.all([
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
    };
  });

  return {
    today,
    overdue: flatten(overdue.data),
    upcomingWeek: flatten(upcoming.data),
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
    };
    entry.count += 1;
    entry.amount += row.amount;
    entry.max_days_late = Math.max(entry.max_days_late, row.days_late);
    byCustomer.set(key, entry);
  }

  const behind = [...byCustomer.values()].sort((a, b) => b.amount - a.amount);
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
  if (state.pendingDocuments.length) {
    sentences.push(`${state.pendingDocuments.length} document${state.pendingDocuments.length > 1 ? 's are' : ' is'} still waiting to be issued.`);
  }
  if (behind.length) {
    sentences.push(`Start with ${behind[0].customer_name} — ${naira(behind[0].amount)}, ${behind[0].max_days_late} day${behind[0].max_days_late === 1 ? '' : 's'} late.`);
  }

  return {
    summary: sentences.join(' '),
    risks: behind.map((c) => ({
      customer_name: c.customer_name,
      reason: `${c.count} missed installment${c.count > 1 ? 's' : ''} totalling ${naira(c.amount)}, oldest ${c.max_days_late} day${c.max_days_late === 1 ? '' : 's'} late`,
      severity: c.count >= 3 || c.max_days_late > 60 ? 'high' : c.count >= 2 || c.max_days_late > 30 ? 'medium' : 'low',
    })),
    follow_ups: behind.slice(0, 10).map((c) => ({
      customer_name: c.customer_name,
      reservation_id: c.reservation_id,
      whatsapp_draft:
        `Good morning ${c.customer_name}, this is a gentle reminder from the sales team regarding ` +
        `${c.unit_number ? `Unit ${c.unit_number}` : 'your unit'}${c.project ? ` at ${c.project}` : ''}. ` +
        `We have ${naira(c.amount)} outstanding on your payment plan. ` +
        `Kindly let us know when we should expect it, or reply here if you would like to discuss the schedule. Thank you.`,
      email_subject: `Outstanding installment — ${c.unit_number ? `Unit ${c.unit_number}` : 'your allocation'}`,
      email_draft:
        `Dear ${c.customer_name},\n\n` +
        `We hope this message finds you well. Our records show ${naira(c.amount)} outstanding across ` +
        `${c.count} installment${c.count > 1 ? 's' : ''} on ${c.unit_number ? `Unit ${c.unit_number}` : 'your unit'}` +
        `${c.project ? ` at ${c.project}` : ''}.\n\n` +
        `Please let us know when we can expect payment, or contact us if you would like to review the schedule.\n\n` +
        `Kind regards,\nSales Team`,
    })),
    recommendations: behind.slice(0, 5).map((c) => ({
      title: `Call ${c.customer_name} about ${c.count} missed installment${c.count > 1 ? 's' : ''} (${naira(c.amount)})`,
      reservation_id: c.reservation_id,
    })),
  };
}

// ── Model call ─────────────────────────────────────────────────────────────
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
            'WhatsApp drafts must be warm but professional, under 80 words, and never threatening — ' +
            'these are valued installment customers, not debtors. ' +
            'Only reference customers present in the data, never invent names, amounts or dates. ' +
            'Use reservation_id values exactly as given.',
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
    try {
      brief = await requestBriefFromModel(state);
    } catch (err) {
      // The brief is the product's daily heartbeat — a model outage degrades
      // the wording, it does not skip the morning.
      console.error('[re-brief] model call failed, using rule-based brief:', err.message);
      brief = buildFallbackBrief(state);
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
