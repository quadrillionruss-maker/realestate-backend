// jobs/daily.js — 07:00 Africa/Lagos: mark overdue, then brief every org.
//
// MOUNTING (FlowDesk's src/app.js, once):
//   require('./re/jobs/daily');
//
// Railway keeps the process alive, so node-cron is enough; there is no need
// for a separate scheduler service at this size. Set RE_DISABLE_CRON=true to
// keep it quiet in local development or tests.
//
// 07:00 Lagos is chosen so the brief is already waiting when the MD opens the
// app — the product's whole promise is that the thinking happened overnight.

const cron = require('node-cron');
const { supabaseAdmin } = require('../middleware/orgContext');
const { markOverdue } = require('../services/overdueService');
const { generateDailyBrief } = require('../services/aiBrief');

const SCHEDULE = process.env.RE_BRIEF_CRON || '0 7 * * *';

async function runDailyJob() {
  const flipped = await markOverdue();
  console.log(`[re-daily] marked ${flipped} installment(s) overdue`);

  // Brief every org that has at least one project. Orgs using FlowDesk purely
  // for invoicing never see a real estate brief.
  const { data: projects, error } = await supabaseAdmin
    .from('re_projects')
    .select('organization_id');
  if (error) throw error;

  const orgIds = [...new Set((projects || []).map((p) => p.organization_id))];
  let succeeded = 0;

  for (const orgId of orgIds) {
    try {
      await generateDailyBrief(orgId);
      succeeded += 1;
    } catch (err) {
      // One org's failure must not cost every other org their morning brief.
      console.error(`[re-daily] brief failed for org ${orgId}:`, err.message);
    }
  }

  console.log(`[re-daily] briefed ${succeeded}/${orgIds.length} org(s)`);
  return { flipped, orgs: orgIds.length, succeeded };
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
