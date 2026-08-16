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
const projectHealth = require('./projectHealthService');
const pushService = require('./pushService');
const featureUsage = require('./featureUsageService');

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
          required: ['customer_ref', 'reason', 'severity'],
          properties: {
            customer_ref: { type: 'string', description: 'The exact customer_ref token from the data, e.g. BUYER_3. Never a name.' },
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
          required: ['customer_ref', 'reservation_id', 'whatsapp_draft', 'email_subject', 'email_draft'],
          properties: {
            customer_ref: { type: 'string', description: 'The exact customer_ref token from the data, e.g. BUYER_3. Never a name.' },
            reservation_id: { type: ['string', 'null'] },
            whatsapp_draft: { type: 'string', description: 'Short, warm, Nigerian business tone. Naira amounts formatted with ₦ and commas. Address the buyer by writing their customer_ref token exactly where their name would go — it is replaced with their real name automatically before anyone reads it.' },
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

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

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
        id, escalation_stage, property_type,
        re_customers(id, full_name, phone, email),
        re_units(unit_number, re_projects(name))
      )
    )`;

  // SECTION 2 — yesterday's call/visit notes. Read the same way a human would
  // scan the log before writing the brief: everything logged since this time
  // yesterday, so a rep who calls at 6pm still makes tomorrow's 7am brief.
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);

  const [overdue, upcoming, documents, promises, activities] = await Promise.all([
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
      .select('id, doc_type, status, reservation_id, re_reservations(re_customers(id, full_name), re_units(unit_number))')
      .eq('organization_id', orgId)
      .eq('status', 'pending'),
    // What buyers said they would do. "Promised the 15th, still nothing" is a
    // sharper line than "overdue since the 1st", because the buyer chose the
    // date themselves and the model can say so.
    openAndBrokenForBrief(orgId).catch((err) => {
      console.warn('[re-brief] could not read promises:', err.message);
      return [];
    }),
    supabaseAdmin
      .from('re_activities')
      .select('activity_type, notes, outcome, created_at, re_customers(id, full_name)')
      .eq('organization_id', orgId)
      .gte('created_at', `${yesterday}T00:00:00.000Z`)
      .lt('created_at', `${today}T00:00:00.000Z`)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .catch((err) => {
        console.warn('[re-brief] could not read activities:', err.message);
        return { data: [] };
      }),
  ]);

  // A stable, opaque token per buyer — BUYER_1, BUYER_2… — assigned once
  // across the whole state so the same buyer gets the same ref whether they
  // show up in overdue, upcoming, or pending documents. Used ONLY to build
  // the payload requestBriefFromModel actually sends to OpenAI; every row
  // below still carries the real customer_name too, because
  // buildFallbackBrief and the rest of this file need it and never talk to
  // a third party. refByCustomerId resolves the model's response back to a
  // real name afterwards — see requestBriefFromModel.
  const refByCustomerId = new Map();
  const nameByRef = new Map();
  // TASK 2.5 — the other direction of refByCustomerId, so a buyer mentioned
  // in the brief's prose or listed as a risk/follow-up can be resolved back
  // to their real id and opened in a drawer. Built at the same point as
  // nameByRef so the two never drift out of sync (one ref, one name, one id).
  const idByRef = new Map();
  // SECTION 15 — same reasoning as idByRef: built alongside the others so it
  // can never drift, and never sent to the model (sanitizeStateForModel
  // strips customer_phone the same way it already strips customer_name).
  const phoneByRef = new Map();
  function refFor(customer) {
    if (!customer?.id) return null;
    let ref = refByCustomerId.get(customer.id);
    if (!ref) {
      ref = `BUYER_${refByCustomerId.size + 1}`;
      refByCustomerId.set(customer.id, ref);
      nameByRef.set(ref, customer.full_name || 'Unknown buyer');
      idByRef.set(ref, customer.id);
      phoneByRef.set(ref, customer.phone || null);
    }
    return ref;
  }

  // Flatten the join shape into something compact enough to put in a prompt
  // without spending tokens on Supabase's nesting.
  const flatten = (rows) => (rows || []).map((row) => {
    const reservation = row.re_installment_plans?.re_reservations || {};
    const customer = reservation.re_customers || {};
    const unit = reservation.re_units || {};
    return {
      schedule_id: row.id,
      reservation_id: reservation.id || null,
      customer_ref: refFor(customer),
      customer_id: customer.id || null,
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
      // A tenant 30 days late on rent and a buyer who missed an off-plan
      // installment are different situations, and the brief should not use
      // one word for both. See termsFor() below.
      property_type: reservation.property_type || 'off_plan',
    };
  });

  const flatOverdue = flatten(overdue.data);
  const flatUpcoming = flatten(upcoming.data);

  // Promises carry no customer_id (promiseService.js is shared and has its
  // own reasons not to), so matching to a ref is by name — the same
  // assumption buildFallbackBrief already makes to line up a promise with
  // its buyer, not a new fragility this introduces.
  const refByName = new Map();
  for (const [, ref] of refByCustomerId) {
    const name = nameByRef.get(ref);
    if (name) refByName.set(name.toLowerCase(), ref);
  }

  return {
    today,
    overdue: flatOverdue,
    upcomingWeek: flatUpcoming,
    promises: (promises || []).map((p) => ({
      ...p,
      customer_ref: refByName.get(String(p.customer_name || '').toLowerCase()) || null,
    })),
    pendingDocuments: (documents.data || []).map((d) => {
      const customer = d.re_reservations?.re_customers || null;
      return {
        id: d.id,
        doc_type: d.doc_type,
        reservation_id: d.reservation_id,
        customer_ref: refFor(customer),
        customer_name: customer?.full_name || null,
        unit_number: d.re_reservations?.re_units?.unit_number || null,
      };
    }),
    // SECTION 2 — yesterday's call/visit notes, so the brief can say "Mrs
    // Adeyemi called yesterday and said she will pay Monday" instead of
    // flagging her as silently overdue. refFor() may mint a fresh ref here
    // for a buyer who has no overdue/upcoming/document row at all — talking
    // to someone with nothing else due is still worth a line in the brief.
    recentActivities: (activities.data || []).map((a) => ({
      customer_ref: refFor(a.re_customers),
      customer_name: a.re_customers?.full_name || 'Unknown buyer',
      activity_type: a.activity_type,
      outcome: a.outcome || null,
      notes: a.notes,
    })),
    // Not sent to OpenAI (see requestBriefFromModel) — kept on the state
    // object so the model's ref-only response can be resolved back to a
    // real name (and, via idByRef, a real id) before anyone reads the brief.
    nameByRef,
    idByRef,
    phoneByRef,
  };
}

// SECTION 2 — how each activity_type reads as a sentence verb. re_activities
// itself does not carry these words (migrations/029's check constraint is
// the source of truth for the six values) — this is presentation only.
const ACTIVITY_VERB = {
  call: 'called',
  visit: 'visited',
  site_visit: 'visited on site',
  whatsapp: 'messaged on WhatsApp',
  email: 'emailed',
  note: 'noted',
};

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
      customer_id: row.customer_id || null,
      // SECTION 15 — carried through to follow_ups below so the dashboard's
      // "Send all" queue can open WhatsApp Web for each draft without a
      // second buyer lookup.
      customer_phone: row.customer_phone || null,
      reservation_id: row.reservation_id,
      project: row.project,
      unit_number: row.unit_number,
      count: 0,
      amount: 0,
      max_days_late: 0,
      escalation_stage: row.escalation_stage || null,
      // Taken from this row like reservation_id and unit_number are: the
      // per-customer grouping already collapses to one representative
      // reservation, so a tenant is not going to be mislabelled a buyer
      // partway through their own entry.
      property_type: row.property_type || 'off_plan',
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
  const upcomingTotal = state.upcomingWeek.reduce((sum, r) => sum + r.amount, 0);

  // A tenant 30 days late on rent and an off-plan buyer who missed a payment
  // are different situations, and the summary line should not flatten them
  // into the same word — split by CUSTOMER (not by row) so "3 buyers" never
  // silently includes a tenant, or the reverse.
  const behindTenants = behind.filter((c) => c.property_type === 'rental');
  const behindBuyers = behind.filter((c) => c.property_type !== 'rental');
  const rowCount = (rows) => rows.reduce((sum, c) => sum + c.count, 0);
  const rowAmount = (rows) => rows.reduce((sum, c) => sum + c.amount, 0);

  const sentences = [];
  if (behind.length) {
    const parts = [];
    if (behindBuyers.length) {
      const n = rowCount(behindBuyers);
      parts.push(`${behindBuyers.length} buyer${behindBuyers.length > 1 ? 's are' : ' is'} behind on ${naira(rowAmount(behindBuyers))} across ${n} installment${n > 1 ? 's' : ''}`);
    }
    if (behindTenants.length) {
      const n = rowCount(behindTenants);
      parts.push(`${behindTenants.length} tenant${behindTenants.length > 1 ? 's are' : ' is'} behind on ${naira(rowAmount(behindTenants))} in rent across ${n} payment${n > 1 ? 's' : ''}`);
    }
    sentences.push(`${parts.join('; ')}.`);
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

  // SECTION 2 — yesterday's call/visit notes. A buyer already spoken to reads
  // differently from one who has simply gone quiet — "Mrs Adeyemi called
  // yesterday and said she will pay Monday" is a different fact from "Mrs
  // Adeyemi is 30 days overdue" even though both are true of the same person.
  // Capped at 3 lines: this is a summary paragraph, not the activity log
  // itself — the full log is on the buyer's own drawer.
  for (const activity of (state.recentActivities || []).slice(0, 3)) {
    const verb = ACTIVITY_VERB[activity.activity_type] || 'contacted';
    sentences.push(
      `${activity.customer_name} was ${verb} yesterday`
      + (activity.outcome === 'promised_payment' ? ' and promised payment' : '')
      + (activity.notes ? ` — "${activity.notes}"` : '') + '.'
    );
  }

  return {
    summary: sentences.join(' '),
    risks: behind.map((c) => {
      const t = termsFor(c);
      return {
        customer_name: c.customer_name,
        customer_id: c.customer_id,
        reason: `${c.count} missed ${t.noun}${c.count > 1 ? 's' : ''} totalling ${naira(c.amount)}, oldest ${c.max_days_late} day${c.max_days_late === 1 ? '' : 's'} late`
          + (c.promise?.status === 'broken' ? `; promised to pay by ${c.promise.promised_date} and did not` : '')
          + (c.promise?.status === 'open' ? `; promised to pay by ${c.promise.promised_date}` : ''),
        severity: severityFor(c),
      };
    }),
    // Nobody at legal stage gets a drafted message. Anything written to a
    // buyer whose file is with a lawyer can be read back in court, and that
    // is not a sentence an automated draft should be composing.
    follow_ups: behind.filter((c) => c.stage.key !== 'legal').slice(0, 10).map((c) => {
      const t = termsFor(c);
      return {
        customer_name: c.customer_name,
        customer_id: c.customer_id,
        customer_phone: c.customer_phone,
        reservation_id: c.reservation_id,
        whatsapp_draft: draftFor(c),
        email_subject: c.stage.key === 'reminder'
          ? `Outstanding ${t.noun} — ${c.unit_number ? `Unit ${c.unit_number}` : t.theirUnit}`
          : `Arrears notice — ${c.unit_number ? `Unit ${c.unit_number}` : t.theirUnit}`,
        email_draft: emailFor(c),
      };
    }),
    recommendations: behind.slice(0, 5).map((c) => {
      const t = termsFor(c);
      return {
        title: c.stage.key === 'legal'
          ? `Refer ${c.customer_name} to legal review — ${c.count} missed ${t.noun}${c.count > 1 ? 's' : ''} (${naira(c.amount)})`
          : c.promise?.status === 'broken'
            ? `Call ${c.customer_name} — broke a promise to pay by ${c.promise.promised_date} (${naira(c.amount)})`
            : `Call ${c.customer_name} about ${c.count} missed ${t.noun}${c.count > 1 ? 's' : ''} (${naira(c.amount)})`,
        reservation_id: c.reservation_id,
      };
    }),
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

// A tenant 30 days late on rent is a different situation from an off-plan
// buyer who missed a payment, and the drafted message must not use the wrong
// vocabulary for either one — "your Contract of Sale" means nothing to a
// renter, and "installment" undersells what a tenant actually owes monthly.
// One lookup, everywhere a wording site would otherwise need its own
// property_type check.
function termsFor(c) {
  const rental = c.property_type === 'rental';
  return {
    isRental: rental,
    noun: rental ? 'rent payment' : 'installment',
    theirUnit: rental ? 'your tenancy' : 'your allocation',
    planWord: rental ? 'rent schedule' : 'payment plan',
    contractWord: rental ? 'Tenancy Agreement' : 'Contract of Sale',
    atRiskPhrase: rental ? 'this tenancy is at risk' : 'this allocation is at risk',
  };
}

function draftFor(c) {
  const t = termsFor(c);

  if (c.promise?.status === 'broken') {
    return `Good morning ${c.customer_name}. We spoke about ${where(c)} and understood payment would come through by `
      + `${c.promise.promised_date}. We have not seen it yet — is there anything holding it up? `
      + `${naira(c.amount)} is currently outstanding. Do let us know a date that works and we will note it. Thank you.`;
  }

  if (c.stage.key === 'final_notice') {
    return `Dear ${c.customer_name}, our records show ${naira(c.amount)} outstanding across ${c.count} ${t.noun}${c.count > 1 ? 's' : ''} on `
      + `${where(c)}. Under the terms of your ${t.contractWord}, continued arrears mean ${t.atRiskPhrase}. `
      + `Please contact us before the end of this week to settle the balance or agree a revised schedule.`;
  }

  if (c.stage.key === 'formal_notice') {
    return `Dear ${c.customer_name}, this is a formal reminder that ${naira(c.amount)} is outstanding across `
      + `${c.count} ${t.noun}${c.count > 1 ? 's' : ''} on ${where(c)}, as set out in your ${t.contractWord}. `
      + `Kindly confirm a specific date on which we should expect payment, or contact us to discuss the schedule.`;
  }

  return `Good morning ${c.customer_name}, this is a gentle reminder from the ${t.isRental ? 'lettings' : 'sales'} team regarding ${where(c)}. `
    + `We have ${naira(c.amount)} outstanding on your ${t.planWord}. `
    + `Kindly let us know when we should expect it, or reply here if you would like to discuss the schedule. Thank you.`;
}

function emailFor(c) {
  const t = termsFor(c);
  const opening = c.stage.key === 'reminder'
    ? 'We hope this message finds you well. Our records show'
    : 'Our records show';

  const body = `Dear ${c.customer_name},\n\n`
    + `${opening} ${naira(c.amount)} outstanding across ${c.count} ${t.noun}${c.count > 1 ? 's' : ''} on ${where(c)}.\n\n`
    + (c.promise?.status === 'broken'
      ? `We understood from our last conversation that payment would be made by ${c.promise.promised_date}.\n\n`
      : '')
    + (c.stage.key === 'final_notice'
      ? `Under the terms of your ${t.contractWord}, continued arrears mean ${t.atRiskPhrase}. Please settle the balance or contact us to agree a revised schedule before the end of this week.\n\n`
      : 'Please let us know when we can expect payment, or contact us if you would like to review the schedule.\n\n');

  return `${body}Kind regards,\n${t.isRental ? 'Lettings' : 'Sales'} Team`;
}

// ── Model call ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Worth trying again: a timeout, a dropped connection, a rate limit, a
// garbled completion, or any 5xx. Not worth trying again: a malformed
// request or a rejected key.
function isRetryable(err) {
  if (err.malformedResponse) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const status = Number((/OpenAI (\d{3})/.exec(err.message) || [])[1] || 0);
  if (!status) return true;          // network-level failure, no status to read
  if (status === 429) return true;   // rate limited
  return status >= 500;
}

// Everywhere a buyer's real name would have gone in the payload, the data
// instead carries a customer_ref token (BUYER_1, BUYER_2…) — see
// gatherOrgState. Buyer names, phone numbers and emails never leave this
// server: OpenAI never receives them, only opaque per-buyer tokens, and
// resolveRefs() maps the model's response back to real names once it
// returns. This is why the schema asks for customer_ref rather than
// customer_name, and why the system prompt tells the model to write that
// same token directly into a drafted message where a name would go.
function sanitizeStateForModel(state) {
  const stripPII = (row) => {
    const { customer_name, customer_phone, customer_email, ...rest } = row;
    return rest;
  };
  return {
    today: state.today,
    overdue: state.overdue.map(stripPII),
    upcomingWeek: state.upcomingWeek.map(stripPII),
    pendingDocuments: state.pendingDocuments.map(stripPII),
    promises: state.promises.map(stripPII),
    recentActivities: (state.recentActivities || []).map(stripPII),
  };
}

// The other half of the boundary above: the model only ever knows a buyer as
// BUYER_3, so it can only ever hand back BUYER_3 — in the structured
// customer_ref fields, and (per the system prompt) written directly into
// whatsapp_draft/email_draft/email_subject/recommendation titles where a
// name belongs. This resolves every one of those back to the real name
// before the brief is stored or shown to anyone.
function resolveRefs(brief, nameByRef, idByRef = new Map(), phoneByRef = new Map()) {
  const nameFor = (ref) => nameByRef.get(ref) || 'this buyer';
  const replaceRefs = (text) => {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const [ref, name] of nameByRef) out = out.replace(new RegExp(`\\b${ref}\\b`, 'g'), name);
    return out;
  };

  // TASK 2.5 — customer_id travels alongside customer_name from here on, so
  // the frontend can make a buyer's name clickable without a second lookup.
  const risks = (brief.risks || []).map(({ customer_ref, ...rest }) => ({
    customer_name: nameFor(customer_ref),
    customer_id: idByRef.get(customer_ref) || null,
    ...rest,
  }));

  const follow_ups = (brief.follow_ups || []).map(({ customer_ref, ...rest }) => ({
    customer_name: nameFor(customer_ref),
    customer_id: idByRef.get(customer_ref) || null,
    customer_phone: phoneByRef.get(customer_ref) || null,
    ...rest,
    whatsapp_draft: replaceRefs(rest.whatsapp_draft),
    email_subject: replaceRefs(rest.email_subject),
    email_draft: replaceRefs(rest.email_draft),
  }));

  const recommendations = (brief.recommendations || []).map((rec) => ({
    ...rec,
    title: replaceRefs(rec.title),
  }));

  return { ...brief, summary: replaceRefs(brief.summary), risks, follow_ups, recommendations };
}

async function requestBriefFromModel(state) {
  const promptState = sanitizeStateForModel(state);
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.openai.apiKey}`,
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
            // TASK 2.4 — without this the model reads "morning brief" as
            // license to pick the one or two most urgent buyers and stop,
            // the same way a human skimming the list would only mention the
            // worst case out loud. follow_ups is a WORK QUEUE a rep copies
            // messages out of one at a time, not a highlight reel — every
            // buyer who is left un-drafted here is a buyer nobody hears
            // from today.
            'follow_ups is a WORKLIST, not a highlights reel: include exactly one entry for EVERY customer_ref that ' +
            'appears in `overdue`, with no exceptions other than the legal-stage rule below. If eight distinct ' +
            'customer_ref values appear in `overdue`, follow_ups must contain eight entries (minus any at the legal ' +
            'stage) — never fewer, regardless of how minor some of them individually seem. Prioritisation belongs in ' +
            'the ORDER of the array and in `risks`/`recommendations`, never in leaving a buyer out of follow_ups ' +
            'entirely.\n\n' +
            // Buyer names never reach this prompt (see sanitizeStateForModel) —
            // each row carries customer_ref instead (e.g. BUYER_3). Without this
            // paragraph the model either invents a name to fill the gap or
            // leaves drafts addressed to nobody; told what the token is FOR, it
            // uses it exactly like a name and the real one is substituted back
            // in afterwards.
            'Every buyer in this data is identified by customer_ref (e.g. "BUYER_3") instead of a name — ' +
            'you are not given real names, phone numbers or email addresses. Use the customer_ref value exactly ' +
            'as given in the customer_ref field of your output. Where a buyer\'s name would naturally appear inside ' +
            'a drafted message (a greeting, a recommendation title), write their customer_ref token there instead, ' +
            'exactly as given — e.g. "Dear BUYER_3," — it will be replaced with their real name automatically ' +
            'before anyone reads it. Never invent a name, and never leave a customer_ref field blank.\n\n' +
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
            // A tenant 30 days late on rent and an off-plan buyer who missed a
            // payment are different situations. Without this the model happily
            // writes "your Contract of Sale" to somebody who is renting, not
            // buying.
            'CHECK property_type ON EACH OVERDUE/UPCOMING ROW:\n' +
            '- property_type "rental": say "rent" or "rent payment", never "installment". Reference their ' +
            '"Tenancy Agreement", never "Contract of Sale". If arrears put the tenancy at risk, say ' +
            '"this tenancy is at risk" — never "this allocation is at risk", which describes a sale, not a lease.\n' +
            '- property_type "off_plan" or "outright": wording stays exactly as before — "installment", ' +
            '"Contract of Sale", "this allocation is at risk".\n\n' +
            'The `promises` array is what buyers themselves said they would do. A buyer with a status:"broken" ' +
            'promise should be high severity and appear first: they named the date, not us. Reference it directly ' +
            '("we understood payment would come through by the 15th"), and never repeat a due date they have ' +
            'already acknowledged as though they had not.\n\n' +
            // SECTION 2 — without this the model recommends "call BUYER_3"
            // for someone a rep already called yesterday, which reads as the
            // AI not having read its own data.
            'The `recentActivities` array is what staff logged about a buyer YESTERDAY — a call, a visit, a ' +
            'WhatsApp exchange. If a buyer in `overdue` or `upcomingWeek` also appears in `recentActivities`, ' +
            'use it: mention what was already said instead of recommending they be contacted again, and if the ' +
            'note or outcome is "promised_payment", reference the promise in the summary the same way a broken ' +
            '`promises` entry is referenced. A buyer who ONLY appears in `recentActivities` (no arrears, nothing ' +
            'due) is worth a short mention in the summary if the outcome or notes are notable ' +
            '(e.g. "interested", "not_interested") — never invent a follow_up or recommendation for them alone.',
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
  if (!content) throw Object.assign(new Error('OpenAI returned an empty brief'), { malformedResponse: true });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    // A garbled or truncated completion — the request itself succeeded, so
    // this is nothing like a bad API key or a malformed request (the cases
    // isRetryable says to give up on). It is usually a one-off from the
    // model, and worth exactly the same second attempt as a dropped
    // connection.
    throw Object.assign(new Error(`OpenAI returned unparsable JSON: ${err.message}`), { malformedResponse: true });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(new Error('OpenAI returned JSON that was not a brief object'), { malformedResponse: true });
  }

  return resolveRefs(parsed, state.nameByRef, state.idByRef, state.phoneByRef);
}

// SECTION 15 — "Include project health summary in the Monday morning
// brief for the owner." Read off state.today (lagosToday(), already
// Africa/Lagos) rather than the server's own local clock, matching every
// other date decision in this file.
function isMonday(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay() === 1;
}

// ── Orchestration ──────────────────────────────────────────────────────────
async function generateDailyBrief(orgId) {
  const state = await gatherOrgState(orgId);
  const nothingToReport =
    !state.overdue.length && !state.upcomingWeek.length && !state.pendingDocuments.length;

  // Attached to the brief's own payload rather than folded into `summary`
  // (which sales_director also reads, per dashboard.js) — the DASHBOARD
  // decides whether to render this block, gated on projectHealth.read
  // (owner only), the same "shared data, gated display" split
  // documentationDashboard's own comment describes for a different field.
  let projectHealthSummary = null;
  if (isMonday(state.today)) {
    try {
      projectHealthSummary = await projectHealth.summaryForBrief(orgId);
    } catch (err) {
      console.warn('[re-brief] could not build Monday project health summary:', err.message);
    }
  }

  // A quiet day is a fact, not a prompt. Don't spend a call restating it.
  if (nothingToReport) {
    const quiet = {
      summary: 'All clear today: no overdue installments, no payments due this week, no documents pending.',
      risks: [],
      follow_ups: [],
      recommendations: [],
      project_health_summary: projectHealthSummary,
    };
    await storeBrief(orgId, quiet, 'fallback');
    return { ...quiet, generated_by: 'fallback' };
  }

  let brief;
  let generatedBy = 'ai';

  if (!env.openai.apiKey) {
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

  brief.project_health_summary = projectHealthSummary;

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

  featureUsage.track(orgId, 'brief_generated');

  // SECTION 1 — push, owner only. Covers both the 07:00 cron path and a
  // manual "Regenerate" click from the dashboard, since both call this same
  // function — one place writing the brief is one place notifying about it.
  const ownerIds = await pushService.resolveUserIdsByRole(orgId, ['owner']);
  await pushService.notify(orgId, ownerIds, {
    title: 'Morning brief ready',
    body: brief.summary ? String(brief.summary).slice(0, 120) : 'Your daily brief is ready.',
    url: '/#/dashboard',
  });
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
    // 23505 = uniq_re_tasks_open_ai_title (migrations/013) — the check above
    // lost a race with another run filing the same recommendation. Same
    // outcome as finding the duplicate up front: skip it.
    if (error && error.code !== '23505') console.error('[re-brief] could not file task:', error.message);
  }
}

module.exports = {
  generateDailyBrief, gatherOrgState, buildFallbackBrief,
  sanitizeStateForModel, resolveRefs,
};
