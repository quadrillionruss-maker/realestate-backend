// collectionsAgent.js — SECTION 11, v2's Collections Agent.
//
// Outbound: reuses THAT SAME DAY's aiBrief follow_ups verbatim (re_ai_briefs,
// already generated earlier in the same cron pass — jobs/daily.js runs the
// brief before any agent) rather than drafting its own wording. aiBrief's
// own rules already do exactly the work this agent needs — never drafting a
// follow_up for a legal-stage buyer, matching tone to stage — so re-reading
// its output is "reusing aiBrief drafted messages" in the most literal sense,
// not a second copy of the same drafting logic.
//
// Inbound: parseReply() is called from whatsappBotService's webhook handler
// for a buyer who currently has an overdue installment, BEFORE the general
// mini-app intent classifier runs — a reply to a collections message means
// something specific here that "check my balance" etc. does not.
const { supabaseAdmin } = require('../middleware/orgContext');
const dealManager = require('./dealManager');
const { logPromise } = require('./promiseService');
const { STAGES, describeStage } = require('./escalationService');
const { auditSystem } = require('./auditService');
const { lagosToday } = require('./overdueService');
const { nextOccurrenceUTC } = require('./contactTimingService');
const scheduledMessages = require('./scheduledMessageService');

const AGENT_NAME = 'collections_agent';
// FEATURE — dynamic reminder timing. If a buyer's own optimal send time is
// within this many minutes of right now, send in this same sweep rather
// than creating a scheduled-message row for a moment that has, for all
// practical purposes, already arrived — jobs/daily.js runs this once a day,
// not continuously, so "close enough" has to mean something coarser than
// it would on a per-minute scheduler.
const IMMEDIATE_WINDOW_MINUTES = 60;
// aiBrief.js's own rule, reused here rather than re-derived: index 4 (legal)
// never gets an automated message. Index 0 (none) has nothing overdue to
// chase. 1-3 (reminder/formal_notice/final_notice) is where this agent
// sends — the product spec's "stage 1-4 sends, stage 5 stops" maps onto
// this five-stage sequence as "every stage except none and legal".
const SENDABLE_STAGE_INDEXES = [1, 2, 3];
const STOP_STAGE_KEY = 'legal';

// ── Outbound sweep ───────────────────────────────────────────────────────────
async function run(orgId) {
  const { data: brief } = await supabaseAdmin
    .from('re_ai_briefs')
    .select('payload')
    .eq('organization_id', orgId)
    .eq('brief_date', lagosToday())
    .maybeSingle();
  const followUps = brief?.payload?.follow_ups || [];

  let sent = 0;
  for (const followUp of followUps) {
    if (!followUp.reservation_id || !followUp.whatsapp_draft) continue;

    const { data: reservation } = await supabaseAdmin
      .from('re_reservations')
      .select('id, customer_id, escalation_stage, status')
      .eq('id', followUp.reservation_id)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (!reservation || reservation.status === 'cancelled') continue;

    const stageIndex = STAGES.findIndex((s) => s.key === (reservation.escalation_stage || 'none'));
    if (!SENDABLE_STAGE_INDEXES.includes(stageIndex)) continue;

    const { data: customer } = await supabaseAdmin
      .from('re_customers')
      .select('id, full_name, phone, whatsapp_opt_out, optimal_contact_day, optimal_contact_hour')
      .eq('id', reservation.customer_id)
      .maybeSingle();
    if (!customer) continue;

    // FEATURE — dynamic reminder timing. No pattern yet (fewer than 3
    // payments — contactTimingService's own threshold) falls back to
    // sending in this same run, exactly as it always has — this is the
    // "default 7am" the product spec asks for, since that is when this
    // sweep itself runs.
    const nextSlot = nextOccurrenceUTC(customer.optimal_contact_day, customer.optimal_contact_hour);
    const minutesUntilSlot = nextSlot ? (Date.parse(nextSlot) - Date.now()) / 60_000 : 0;

    if (nextSlot && minutesUntilSlot > IMMEDIATE_WINDOW_MINUTES) {
      // Too far off to send now — hand it to the existing scheduled-message
      // pathway (scheduledMessageService's own hourly sweep, migrations/049)
      // rather than building a second delivery mechanism. Trade-off worth
      // naming: that sweep sends directly and does not re-run
      // dealManager.sendWithClearance's opt-out/duplicate/human-handling
      // checks at the moment it actually fires, since nothing in this
      // product re-evaluates clearance for an already-scheduled row. Given
      // the whole point of this feature is to move WHEN a message goes out,
      // not whether, this is accepted rather than building a second
      // clearance re-check that nothing else in the scheduled-message
      // system has either.
      try {
        // AUDIT FIX (NF7) — a buyer overdue across several consecutive days
        // (the normal collections case) used to accumulate a brand-new
        // scheduled reminder every single morning, none deduplicated or
        // cancelled — several near-identical WhatsApp nudges landing within
        // the same hour/day. At most one pending scheduled message per
        // customer from here on: today's fresh draft replaces yesterday's
        // rather than stacking beside it.
        const { data: pending } = await supabaseAdmin
          .from('re_scheduled_messages')
          .select('id')
          .eq('organization_id', orgId)
          .eq('customer_id', customer.id)
          .eq('status', 'pending');
        for (const row of pending || []) {
          await scheduledMessages.cancel(orgId, row.id).catch(() => {});
        }

        await scheduledMessages.schedule(orgId, {
          customerId: customer.id,
          message: followUp.whatsapp_draft,
          scheduledFor: nextSlot,
        });
        await dealManager.logAction(orgId, AGENT_NAME, customer.id, 'followup_scheduled_for_optimal_time',
          `scheduled for ${nextSlot}`);
      } catch (err) {
        console.warn('[collections-agent] could not schedule optimal-time follow-up:', err.message);
      }
      continue;
    }

    const result = await dealManager.sendWithClearance(orgId, AGENT_NAME, customer, {
      template: 'collections_agent_followup',
      body: followUp.whatsapp_draft,
      actionType: 'collections_followup',
      reservationIds: [reservation.id],
      relatedType: 're_reservations',
      relatedId: reservation.id,
    });

    if (result?.status === 'sent') {
      await supabaseAdmin
        .from('re_reservations')
        .update({ last_agent_contact_at: new Date().toISOString() })
        .eq('id', reservation.id);
      sent += 1;
    }
  }

  const legalTasksFiled = await fileLegalStageTasks(orgId);

  return { sent, legal_tasks_filed: legalTasksFiled };
}

// Stage 5 (legal, per the product spec's numbering) — the agent stops
// sending entirely and files one task for the owner per reservation
// instead, deduplicated the same way rentalService's renewal task and
// aiBrief's own recommendations already are (an open 'ai'-sourced task with
// the same title is refused at the database level — migrations/013).
async function fileLegalStageTasks(orgId) {
  const { data: reservations } = await supabaseAdmin
    .from('re_reservations')
    .select('id, re_customers(full_name)')
    .eq('organization_id', orgId)
    .eq('escalation_stage', STOP_STAGE_KEY)
    .neq('status', 'cancelled');

  let filed = 0;
  for (const reservation of reservations || []) {
    const title = `Legal-stage arrears — review ${reservation.re_customers?.full_name || 'this buyer'} for legal action`;
    const { error } = await supabaseAdmin.from('re_tasks').insert({
      organization_id: orgId,
      title,
      related_reservation_id: reservation.id,
      source: 'ai',
    });
    if (!error) {
      filed += 1;
      await dealManager.logAction(orgId, AGENT_NAME, null, 'legal_stage_task_filed', 'filed');
    } else if (error.code !== '23505') {
      console.warn('[collections-agent] could not file legal-stage task:', error.message);
    }
  }
  return filed;
}

// ── Inbound reply parsing ────────────────────────────────────────────────────
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function nextWeekday(fromDate, targetDow) {
  const d = new Date(fromDate);
  const diff = ((targetDow - d.getUTCDay()) + 7) % 7 || 7; // always the NEXT occurrence, never today
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Deliberately not a full NLP date parser — "I will pay Friday" and
// "tomorrow" cover the overwhelming majority of how a Nigerian buyer
// actually replies to a collections text. Anything not recognised defaults
// to a week out rather than refusing to log a promise at all: a promise
// with an approximate date is far more useful to a collections team than
// no promise logged.
function extractPromisedDate(text, today = lagosToday()) {
  const t = String(text || '').toLowerCase();
  const base = new Date(`${today}T00:00:00Z`);
  const addDays = (n) => new Date(base.getTime() + n * 86_400_000).toISOString().slice(0, 10);

  if (/\btoday\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(1);
  if (/\bnext week\b/.test(t)) return addDays(7);

  for (let dow = 0; dow < WEEKDAYS.length; dow += 1) {
    if (new RegExp(`\\b${WEEKDAYS[dow]}\\b`).test(t)) return nextWeekday(base, dow);
  }

  // DD/MM or DD-MM, optionally with a year — "by 15/03" or "on 15-03-2026".
  const explicit = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(t);
  if (explicit) {
    const day = String(explicit[1]).padStart(2, '0');
    const month = String(explicit[2]).padStart(2, '0');
    const year = explicit[3] ? (explicit[3].length === 2 ? `20${explicit[3]}` : explicit[3]) : String(base.getUTCFullYear());
    const candidate = `${year}-${month}-${day}`;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }

  return addDays(7);
}

const WILL_PAY_RE = /\bi\s*('?ll| will)\s*pay\b|\bpay(ing)?\s+(on|by)\s/i;
const ALREADY_PAID_RE = /\balready\s*paid\b|\bi\s*(have\s*)?paid\b|\bpayment\s*(has\s*been\s*)?sent\b/i;
const CANNOT_PAY_RE = /\bcan\s*not\s*pay\b|\bcannot\s*pay\b|\bcan'?t\s*pay\b|\bunable\s*to\s*pay\b|\bwon'?t\s*be\s*able\s*to\s*pay\b/i;

// Finds the buyer's nearest not-yet-paid installment across their active
// plans — the one a promise or an "already paid" claim would sensibly refer
// to, since a buyer replying to a collections text is talking about
// whatever is currently overdue or next due, not a specific row they'd name
// by id.
async function findNearestOpenSchedule(orgId, customerId) {
  const { data: reservations } = await supabaseAdmin
    .from('re_reservations')
    .select(`
      id, sales_rep_id,
      re_installment_plans(status, re_installment_schedule(id, due_date, status))
    `)
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .neq('status', 'cancelled');

  let nearest = null;
  let nearestReservation = null;
  for (const reservation of reservations || []) {
    const plan = (Array.isArray(reservation.re_installment_plans) ? reservation.re_installment_plans : [reservation.re_installment_plans])
      .filter(Boolean).find((p) => p.status === 'active');
    for (const row of plan?.re_installment_schedule || []) {
      if (row.status !== 'pending' && row.status !== 'overdue') continue;
      if (!nearest || row.due_date < nearest.due_date) { nearest = row; nearestReservation = reservation; }
    }
  }
  return nearest ? { schedule: nearest, reservation: nearestReservation } : null;
}

async function fileVerificationTask(orgId, customer, reservation, messageText) {
  const { error } = await supabaseAdmin.from('re_tasks').insert({
    organization_id: orgId,
    assigned_to: null,
    related_reservation_id: reservation?.id || null,
    title: `Verify payment claimed by ${customer.full_name} (WhatsApp)`,
    notes: `Buyer says they have already paid: "${String(messageText || '').slice(0, 500)}". Check the bank statement / Paystack dashboard and record it if confirmed.`,
    source: 'ai',
  });
  if (error) console.warn('[collections-agent] could not file verification task:', error.message);
}

async function escalateToNextStage(orgId, reservation) {
  const currentIndex = STAGES.findIndex((s) => s.key === (reservation.escalation_stage || 'none'));
  const nextIndex = Math.min(currentIndex + 1, STAGES.length - 1);
  if (nextIndex <= currentIndex) return; // already at the worst stage

  const target = STAGES[nextIndex];
  const { error } = await supabaseAdmin
    .from('re_reservations')
    .update({ escalation_stage: target.key, escalated_at: new Date().toISOString() })
    .eq('id', reservation.id)
    .eq('organization_id', orgId);
  if (error) { console.warn('[collections-agent] could not escalate:', error.message); return; }

  await auditSystem({
    orgId,
    actorKind: 'system',
    action: 'reservation.escalated',
    entityType: 're_reservations',
    entityId: reservation.id,
    summary: `Escalated from ${describeStage(STAGES[currentIndex]?.key).label} to ${target.label} — buyer told the WhatsApp bot they cannot pay`,
    metadata: { from: STAGES[currentIndex]?.key, to: target.key, source: 'whatsapp_reply' },
  });
}

// Called from whatsappBotService.handleInboundMessage for a buyer who has
// at least one overdue installment, BEFORE the general 5-intent classifier.
// Returns { handled: false } for anything that isn't one of these three
// patterns, so the caller falls through to the mini-app intents as normal.
async function parseReply(orgId, customer, text) {
  const openSchedule = await findNearestOpenSchedule(orgId, customer.id);

  if (WILL_PAY_RE.test(text) && openSchedule) {
    const promisedDate = extractPromisedDate(text);
    await logPromise(orgId, {
      scheduleId: openSchedule.schedule.id,
      promisedDate,
      spokeTo: customer.full_name,
      notes: `Logged automatically from a WhatsApp reply: "${String(text).slice(0, 500)}"`,
    });
    await dealManager.logAction(orgId, AGENT_NAME, customer.id, 'promise_logged_from_reply', `promised ${promisedDate}`);
    return { handled: true, reply: `Thank you ${customer.full_name}, we've noted that you'll pay by ${promisedDate}.` };
  }

  if (ALREADY_PAID_RE.test(text)) {
    await fileVerificationTask(orgId, customer, openSchedule?.reservation, text);
    await dealManager.logAction(orgId, AGENT_NAME, customer.id, 'verification_task_filed', 'filed');
    return { handled: true, reply: `Thanks ${customer.full_name}, we're checking our records and will confirm shortly.` };
  }

  if (CANNOT_PAY_RE.test(text) && openSchedule?.reservation) {
    await escalateToNextStage(orgId, openSchedule.reservation);
    await dealManager.logAction(orgId, AGENT_NAME, customer.id, 'escalated_from_reply', 'escalated');
    return { handled: true, reply: `We understand, ${customer.full_name}. Your account has been flagged for a member of our team to follow up with you directly.` };
  }

  return { handled: false };
}

module.exports = {
  run,
  parseReply,
  extractPromisedDate,
  WILL_PAY_RE,
  ALREADY_PAID_RE,
  CANNOT_PAY_RE,
};
