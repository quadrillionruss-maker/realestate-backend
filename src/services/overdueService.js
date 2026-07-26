// overdueService.js — flips pending → overdue once the due date has passed.
// Runs every morning before the brief (see jobs/daily.js) so "overdue" means
// the same thing to the dashboard, the at-risk list and the AI.
// Idempotent: re-running it changes nothing.

const { supabaseAdmin } = require('../middleware/orgContext');

// Dates are compared in Africa/Lagos, not the server's timezone. On a UTC
// host just past midnight it is still "yesterday" in Lagos, and an installment
// due today must not be reported overdue to a CEO opening the app at 7am.
function lagosToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // en-CA → YYYY-MM-DD
}

// orgId is optional: the cron sweeps every org, the smoke test scopes to one.
async function markOverdue(orgId = null) {
  let query = supabaseAdmin
    .from('re_installment_schedule')
    .update({ status: 'overdue' })
    .eq('status', 'pending')
    .lt('due_date', lagosToday());

  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query.select('id');
  if (error) throw error;
  return data?.length || 0;
}

module.exports = { markOverdue, lagosToday };
