// overdueService.js — what "overdue" means, and the one place that decides it.
//
// ── THE CUTOFF ─────────────────────────────────────────────────────────────
// An installment due on a date is due by **18:00 Africa/Lagos on that date**.
// Close of business, not midnight.
//
// This used to be undefined, and undefined was expensive in both directions.
// A buyer who transferred at 4pm on their due date could be reported late by a
// server whose clock had already rolled over; and a "due date" nobody could
// state precisely is not a term you can hold anybody to. So it is stated, in
// one function, and the sweep, the brief, the alerts, the reminders and the
// promise tracker all read it from here.
//
// The hour is configurable (RE_DUE_CUTOFF_HOUR) because a developer may run to
// different hours, but it is a single number for the whole workspace: two
// cutoffs is the same as none.
//
// ── WHY 18:00 AND NOT MIDNIGHT ─────────────────────────────────────────────
// Midnight would make an installment paid at 23:50 on its due date "on time"
// and one paid at 00:05 the next morning two weeks late in the arithmetic, for
// fifteen minutes of difference. A business-hours cutoff matches how the
// deadline is actually communicated, and leaves the whole working day to pay.
//
// ── TWO SWEEPS ─────────────────────────────────────────────────────────────
// jobs/daily.js runs markOverdue at 18:05 as well as at 07:00. Without the
// evening run, an installment that missed its 6pm deadline would keep reading
// as "pending" for another thirteen hours, and a rep looking at the screen at
// 7pm would be told the money was still coming.
//
// Idempotent: re-running changes nothing.

const { supabaseAdmin } = require('../middleware/orgContext');
const env = require('../config/env');

// Close of business, Lagos. 0–23.
const DUE_CUTOFF_HOUR = env.overdue.cutoffHour;

const LAGOS = 'Africa/Lagos';

// Dates and hours are read in Africa/Lagos, never in the server's timezone. On
// a UTC host just past midnight it is still yesterday in Lagos, and an
// installment due today must not be reported overdue to a CEO opening the app
// at 7am. Intl rather than a hardcoded +1 — the offset is not this file's
// business even though Nigeria has never observed DST.
function lagosParts(when = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LAGOS,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(when);

  const get = (type) => parts.find((p) => p.type === type)?.value || '00';

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    // Intl renders midnight as "24" in some engines under hour12:false.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

function lagosToday(when = new Date()) {
  return lagosParts(when).date;
}

// The latest due_date whose cutoff has now passed.
//
// Before 18:00 the answer is yesterday — today's installments still have the
// rest of the working day. From 18:00 the answer is today.
//
// This is the whole cutoff, expressed as the one value every overdue query
// needs, so no caller has to reimplement the comparison and get it subtly
// different.
function overdueThroughDate(when = new Date()) {
  const { date, hour } = lagosParts(when);
  if (hour >= DUE_CUTOFF_HOUR) return date;
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

// True once `dueDate` (YYYY-MM-DD) is past its cutoff. Exported for the brief
// and for anything reporting on a single row.
function isPastDue(dueDate, when = new Date()) {
  if (!dueDate) return false;
  return String(dueDate).slice(0, 10) <= overdueThroughDate(when);
}

// Human wording, so the deadline reaches the buyer the same way the system
// applies it. "30 Jul 2026 by 6:00 PM".
function describeDue(dueDate) {
  const label = DUE_CUTOFF_HOUR === 12 ? '12 noon'
    : DUE_CUTOFF_HOUR === 0 ? 'midnight'
    : DUE_CUTOFF_HOUR > 12 ? `${DUE_CUTOFF_HOUR - 12}pm`
    : `${DUE_CUTOFF_HOUR}am`;

  if (!dueDate) return `by ${label}`;
  const formatted = new Date(`${String(dueDate).slice(0, 10)}T12:00:00Z`)
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${formatted} by ${label}`;
}

// orgId is optional: the cron sweeps every org, the smoke test scopes to one.
// Soft-deleted rows are left alone — a deleted installment is not overdue,
// it is not there.
async function markOverdue(orgId = null) {
  let query = supabaseAdmin
    .from('re_installment_schedule')
    .update({ status: 'overdue' })
    .eq('status', 'pending')
    .is('deleted_at', null)
    .lte('due_date', overdueThroughDate());

  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query.select('id');
  if (error) throw error;
  return data?.length || 0;
}

module.exports = {
  markOverdue,
  lagosToday,
  lagosParts,
  overdueThroughDate,
  isPastDue,
  describeDue,
  DUE_CUTOFF_HOUR,
};
