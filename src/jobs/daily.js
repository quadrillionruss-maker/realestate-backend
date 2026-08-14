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
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { markOverdue } = require('../services/overdueService');
const { generateDailyBrief } = require('../services/aiBrief');
const { sweepBrokenPromises } = require('../services/promiseService');
const { sweepEscalations } = require('../services/escalationService');
const { notifyOverdue, remindUpcoming } = require('../services/overdueAlerts');
const { checkTenancyRenewals } = require('../services/rentalService');
const { mapWithConcurrency } = require('../utils/concurrency');
const collectionsAgent = require('../services/collectionsAgent');
const documentAgent = require('../services/documentAgent');
const salesAgent = require('../services/salesAgent');
const financeAgent = require('../services/financeAgent');
const marketIntelAgent = require('../services/marketIntelAgent');

const SCHEDULE = env.cron.schedule;

// One org's OpenAI call running slow (a real, ordinary state — not a rare
// hard-down) used to delay every org queued behind it in a strictly serial
// loop; this runs up to `limit` orgs at once instead. The file's own header
// already discloses that a duplicate run across instances is tolerated, so
// bounding concurrency within ONE run is enough — nothing here needs the
// coordination a real job queue would add.
const ORG_CONCURRENCY = 8;

// SECTION 11 — one agent, one org, never lets a failure propagate past its
// own log line. Named consistently ("[re-daily] agent X failed for org Y")
// so a bad morning is greppable by agent, not just by "something broke".
async function runAgent(orgId, name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[re-daily] ${name} agent failed for org ${orgId}:`, err.message);
  }
}

// ORDER MATTERS, and each step depends on the one above it:
//
//   1. markOverdue          pending → overdue, so "overdue" means one thing
//   2. sweepBrokenPromises  a promise whose date passed unpaid is now broken
//   3. sweepEscalations     stage follows the (now correct) overdue counts
//   4. checkTenancyRenewals a lease due inside 60 days gets flagged, once
//   5. notifyOverdue        reps and the MD hear about it
//   6. generateDailyBrief   the AI reads the settled picture, not a moving one
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

  // A tenancy inside 60 days of its end gets a task asking whether to renew or
  // end it. Filed once per lease (title-matched against open AI tasks), so a
  // sweep that runs every morning for two months does not ask twice.
  const renewals = await checkTenancyRenewals().catch((err) => {
    console.error('[re-daily] tenancy renewal sweep failed:', err.message);
    return { evaluated: 0, filed: 0 };
  });
  if (renewals.filed) {
    console.log(`[re-daily] flagged ${renewals.filed} tenancy renewal(s) for a decision`);
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
  //
  // An RPC rather than a table query: PostgREST has no DISTINCT reachable
  // through the query builder, and fetching organization_id off every
  // non-cancelled reservation platform-wide just to de-duplicate it in Node
  // is a read that grows forever to answer a question whose real answer is a
  // short list of ids (migrations/010).
  const { data: orgRows, error } = await supabaseAdmin.rpc('distinct_reservation_org_ids');
  if (error) throw error;

  const orgIds = (orgRows || []).map((r) => r.organization_id);
  let succeeded = 0;
  let alerted = 0;
  let reminded = 0;

  await mapWithConcurrency(orgIds, ORG_CONCURRENCY, async (orgId) => {
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

    // SECTION 11 — the five v2 agents, each one AFTER the brief above (some
    // read that day's re_ai_briefs row directly — collectionsAgent reuses
    // its drafted follow_ups verbatim, documentAgent/marketIntelAgent fold
    // their own findings back into the same row). Every outbound message any
    // of these five sends is gated by dealManager.clearance() inside the
    // agent itself — see dealManager.js's own comment on why that check
    // lives per-action rather than as one up-front pass. One agent's failure
    // must not cost the others theirs, same reasoning as every step above.
    await runAgent(orgId, 'collections', () => collectionsAgent.run(orgId));
    await runAgent(orgId, 'document', () => documentAgent.run(orgId));
    await runAgent(orgId, 'sales', () => salesAgent.run(orgId));
    await runAgent(orgId, 'finance', () => financeAgent.runIfDue(orgId));
    await runAgent(orgId, 'market-intel', () => marketIntelAgent.runIfDue(orgId));
  });

  console.log(`[re-daily] briefed ${succeeded}/${orgIds.length} org(s), ${alerted} alert(s), ${reminded} reminder(s), `
    + `${renewals.filed} renewal flag(s)`);
  return { flipped, promises, escalations, renewals, orgs: orgIds.length, succeeded, alerted, reminded };
}

// The evening sweep. Installments are due by 18:00 Africa/Lagos
// (overdueService), so without a run just after that an installment which
// missed its deadline reads as "pending" for another thirteen hours — and a rep
// looking at the screen at 7pm is told the money is still coming.
//
// Marking overdue ONLY. No brief, no alerts, no SMS: a text message five
// minutes after a deadline is aggressive, and the morning job is where anybody
// is told anything.
const EVENING_SCHEDULE = env.cron.eveningSchedule;

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
  if (env.cron.disabled) {
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
