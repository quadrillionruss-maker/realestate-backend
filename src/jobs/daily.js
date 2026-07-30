// jobs/daily.js — 07:00 Africa/Lagos: mark overdue, then brief every org.
//
// Scheduled by requiring this file once — server.js does it at the bottom.
//
// The host keeps the web process alive, so node-cron is enough; there is no
// need for a separate scheduler service at this size. Set RE_DISABLE_CRON=true
// to keep it quiet in local development or tests.
//
// One caveat if this ever runs on more than one instance: each instance
// schedules its own timer, so the job would run once per instance. The brief
// upserts on (organization_id, brief_date) and markOverdue is idempotent, so
// duplicates are harmless — but it does mean duplicate OpenAI calls.
//
// 07:00 Lagos is chosen so the brief is already waiting when the MD opens the
// app — the product's whole promise is that the thinking happened overnight.

const cron = require('node-cron');
const { supabaseAdmin } = require('../middleware/orgContext');
const { markOverdue } = require('../services/overdueService');
const { generateDailyBrief } = require('../services/aiBrief');
const { sweepBrokenPromises } = require('../services/promiseService');
const { sweepEscalations } = require('../services/escalationService');
const { notifyOverdue, remindUpcoming } = require('../services/overdueAlerts');

const SCHEDULE = process.env.RE_BRIEF_CRON || '0 7 * * *';

// ORDER MATTERS, and each step depends on the one above it:
//
//   1. markOverdue        pending → overdue, so "overdue" means one thing
//   2. sweepBrokenPromises a promise whose date passed unpaid is now broken
//   3. sweepEscalations    stage follows the (now correct) overdue counts
//   4. notifyOverdue       reps and the MD hear about it
//   5. generateDailyBrief  the AI reads the settled picture, not a moving one
//
// Running the brief before the sweeps would have it describe yesterday's state
// in this morning's email, which is the one thing it must never do.
async function runDailyJob() {
  const flipped = await markOverdue();
  console.log(`[re-daily] marked ${flipped} installment(s) overdue`);

  const promises = await sweepBrokenPromises().catch((err) => {
    console.error('[re-daily] promise sweep failed:', err.message);
    return { broken: 0, kept: 0 };
  });
  if (promises.broken || promises.kept) {
    console.log(`[re-daily] promises: ${promises.broken} broken, ${promises.kept} kept`);
  }

  const escalations = await sweepEscalations().catch((err) => {
    console.error('[re-daily] escalation sweep failed:', err.message);
    return { evaluated: 0, raised: 0 };
  });
  if (escalations.raised) {
    console.log(`[re-daily] raised escalation on ${escalations.raised} reservation(s)`);
  }

  // Brief every org that has at least one RESERVATION.
  //
  // "Has a project" was the old bar and it was too low: an account that created
  // a project, entered no units and reserved nothing has nothing to report, and
  // briefing it produces "All clear today" every morning forever. The brief
  // already short-circuits an empty state without calling the model, so this was
  // never burning tokens — but it was writing a daily row of noise into
  // re_ai_briefs for every abandoned trial signup, which is the thing that
  // actually costs something at a thousand accounts.
  //
  // A reservation is the first point at which there is money to track, which is
  // the first point at which a brief says anything.
  const { data: reservations, error } = await supabaseAdmin
    .from('re_reservations')
    .select('organization_id')
    .neq('status', 'cancelled');
  if (error) throw error;

  const orgIds = [...new Set((reservations || []).map((r) => r.organization_id))];
  let succeeded = 0;
  let alerted = 0;
  let reminded = 0;

  for (const orgId of orgIds) {
    // Alerts first: a rep should hear that their buyer missed a payment even
    // if OpenAI is down and the brief fails.
    try {
      const result = await notifyOverdue(orgId);
      alerted += result.sent;
    } catch (err) {
      console.error(`[re-daily] overdue alerts failed for org ${orgId}:`, err.message);
    }

    // SMS to buyers — three days before a due date, and the morning after one
    // is missed. Off unless the org has turned it on; see overdueAlerts.
    try {
      const result = await remindUpcoming(orgId);
      reminded += result.sent;
    } catch (err) {
      console.error(`[re-daily] buyer reminders failed for org ${orgId}:`, err.message);
    }

    try {
      await generateDailyBrief(orgId);
      succeeded += 1;
    } catch (err) {
      // One org's failure must not cost every other org their morning brief.
      console.error(`[re-daily] brief failed for org ${orgId}:`, err.message);
    }
  }

  console.log(`[re-daily] briefed ${succeeded}/${orgIds.length} org(s), ${alerted} alert(s), ${reminded} reminder(s)`);
  return { flipped, promises, escalations, orgs: orgIds.length, succeeded, alerted, reminded };
}

// The evening sweep. Installments are due by 18:00 Africa/Lagos
// (overdueService), so without a run just after that an installment which
// missed its deadline reads as "pending" for another thirteen hours — and a rep
// looking at the screen at 7pm is told the money is still coming.
//
// Marking overdue ONLY. No brief, no alerts, no SMS: a text message five
// minutes after a deadline is aggressive, and the morning job is where anybody
// is told anything.
const EVENING_SCHEDULE = process.env.RE_EVENING_SWEEP_CRON || '5 18 * * *';

async function runEveningSweep() {
  const flipped = await markOverdue();
  const promises = await sweepBrokenPromises().catch((err) => {
    console.error('[re-evening] promise sweep failed:', err.message);
    return { broken: 0, kept: 0 };
  });
  const escalations = await sweepEscalations().catch((err) => {
    console.error('[re-evening] escalation sweep failed:', err.message);
    return { evaluated: 0, raised: 0 };
  });

  console.log(`[re-evening] ${flipped} installment(s) past the 18:00 cutoff, `
    + `${promises.broken} promise(s) broken, ${escalations.raised} escalation(s) raised`);
  return { flipped, promises, escalations };
}

let task = null;
let eveningTask = null;

function start() {
  if (process.env.RE_DISABLE_CRON === 'true') {
    console.log('[re-daily] disabled via RE_DISABLE_CRON');
    return null;
  }
  if (task) return task; // require() is cached, but guard double-registration

  task = cron.schedule(SCHEDULE, () => {
    runDailyJob().catch((err) => console.error('[re-daily] job failed:', err.message));
  }, { timezone: 'Africa/Lagos' });

  eveningTask = cron.schedule(EVENING_SCHEDULE, () => {
    runEveningSweep().catch((err) => console.error('[re-evening] sweep failed:', err.message));
  }, { timezone: 'Africa/Lagos' });

  console.log(`[re-daily] scheduled "${SCHEDULE}" Africa/Lagos (brief)`);
  console.log(`[re-daily] scheduled "${EVENING_SCHEDULE}" Africa/Lagos (post-cutoff sweep)`);
  return task;
}

// Auto-start on require, so mounting is a single line in app.js.
start();

module.exports = { runDailyJob, start };
