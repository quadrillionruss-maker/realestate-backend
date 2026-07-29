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

  // Brief every org that has at least one project — an account that signed up
  // but never entered inventory gets no brief and costs no tokens.
  const { data: projects, error } = await supabaseAdmin
    .from('re_projects')
    .select('organization_id');
  if (error) throw error;

  const orgIds = [...new Set((projects || []).map((p) => p.organization_id))];
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

let task = null;

function start() {
  if (process.env.RE_DISABLE_CRON === 'true') {
    console.log('[re-daily] disabled via RE_DISABLE_CRON');
    return null;
  }
  if (task) return task; // require() is cached, but guard double-registration

  task = cron.schedule(SCHEDULE, () => {
    runDailyJob().catch((err) => console.error('[re-daily] job failed:', err.message));
  }, { timezone: 'Africa/Lagos' });

  console.log(`[re-daily] scheduled "${SCHEDULE}" Africa/Lagos`);
  return task;
}

// Auto-start on require, so mounting is a single line in app.js.
start();

module.exports = { runDailyJob, start };
