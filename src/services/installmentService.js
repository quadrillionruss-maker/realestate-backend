// installmentService.js — turns "₦24,000,000 over 18 months from 2026-03-01"
// into the row-per-due-date schedule the whole product runs on.
//
// Two things this file guarantees:
//   1. The installments sum to EXACTLY the plan total (kobo arithmetic).
//   2. The same inputs produce the same dates on any server, in any
//      timezone (all date maths is UTC).

const { supabaseAdmin } = require('../middleware/orgContext');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Parse 'YYYY-MM-DD' into a UTC-midnight Date. Anything timezone-local would
// make a schedule generated on a UTC-5 server land a day earlier than the same
// request on a UTC+1 (Lagos) one.
function parseDateUTC(value) {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const str = String(value || '').slice(0, 10);
  if (!ISO_DATE.test(str)) throw new Error(`start_date must be YYYY-MM-DD, got "${value}"`);
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== m - 1) {
    throw new Error(`start_date is not a real date: "${value}"`);
  }
  return date;
}

const toISODate = (date) => date.toISOString().slice(0, 10);

// Add whole months, clamping to the end of the target month.
// A plan starting 31 Jan bills 28 Feb (29 in a leap year), then 31 Mar —
// clamping the day rather than letting it spill into the next month, which
// is how Nigerian developers write these plans by hand.
function addMonthsUTC(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month + months, Math.min(day, lastDayOfTarget)));
}

// Split `totalAmount` into `numberOfInstallments` dues.
// Works in kobo so 10,000,000 / 3 can't drift into 3333333.3333333335, and
// gives the rounding remainder to the FINAL installment so the schedule always
// sums back to the exact plan total.
function buildSchedule({ totalAmount, numberOfInstallments, frequency = 'monthly', startDate }) {
  const totalKobo = Math.round(Number(totalAmount) * 100);
  const count = Number(numberOfInstallments);

  if (!Number.isFinite(totalKobo) || totalKobo <= 0) {
    throw new Error('total_amount must be a positive number');
  }
  if (!Number.isInteger(count) || count < 1 || count > 120) {
    throw new Error('number_of_installments must be a whole number between 1 and 120');
  }

  const start = parseDateUTC(startDate);
  const stepMonths = frequency === 'quarterly' ? 3 : 1;
  const baseKobo = Math.floor(totalKobo / count);
  const remainderKobo = totalKobo - baseKobo * count;

  const rows = [];
  for (let i = 0; i < count; i++) {
    const amountKobo = i === count - 1 ? baseKobo + remainderKobo : baseKobo;
    rows.push({
      installment_number: i + 1,
      due_date: toISODate(addMonthsUTC(start, i * stepMonths)),
      amount_due: amountKobo / 100,
      status: 'pending',
    });
  }
  return rows;
}

// Creates the plan and its schedule. Supabase's REST API has no client-side
// transaction, so this is best-effort atomic: if the schedule insert fails the
// plan is deleted, leaving no half-built plan for the dashboard to total up.
async function createPlanWithSchedule(orgId, {
  reservationId,
  totalAmount,
  numberOfInstallments,
  frequency = 'monthly',
  startDate,
}) {
  // Validate before writing anything, so a bad request can't leave a plan row.
  const schedule = buildSchedule({ totalAmount, numberOfInstallments, frequency, startDate });

  const { data: plan, error: planErr } = await supabaseAdmin
    .from('re_installment_plans')
    .insert({
      organization_id: orgId,
      reservation_id: reservationId,
      total_amount: totalAmount,
      number_of_installments: numberOfInstallments,
      frequency,
      start_date: startDate,
    })
    .select()
    .single();
  if (planErr) throw planErr;

  const rows = schedule.map((r) => ({ ...r, organization_id: orgId, plan_id: plan.id }));

  const { data: inserted, error: schedErr } = await supabaseAdmin
    .from('re_installment_schedule')
    .insert(rows)
    .select()
    .order('installment_number');

  if (schedErr) {
    await supabaseAdmin.from('re_installment_plans').delete().eq('id', plan.id);
    throw schedErr;
  }

  return { plan, schedule: inserted };
}

module.exports = { createPlanWithSchedule, buildSchedule, addMonthsUTC, parseDateUTC };
