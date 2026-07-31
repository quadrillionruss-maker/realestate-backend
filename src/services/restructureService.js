// restructureService.js — renegotiating a payment plan without losing anything.
//
// A buyer misses three installments and the developer negotiates a revised
// schedule rather than cancelling: monthly to quarterly, a three-month
// moratorium, a longer tail. This happens constantly in Nigerian off-plan
// sales, and before this the only route through the product was to cancel the
// reservation and re-enter it — which threw away the payment history, the
// receipts' references, and the buyer's allocation.
//
// ── WHAT A RESTRUCTURE DOES ────────────────────────────────────────────────
//   1. reads how much has actually been paid against the current plan
//   2. creates a NEW plan for the REMAINING balance, on the new terms
//   3. marks the old plan 'superseded' and points it at the new one
//   4. waives the old plan's unpaid rows so they stop counting as owed
//   5. leaves every paid row and every payment exactly where it was
//
// ── WHY THE NEW PLAN'S TOTAL IS THE BALANCE, NOT THE CONTRACT ──────────────
// installmentService guarantees the schedule sums to the plan total to the
// kobo. That invariant is tested, load-bearing, and worth more than the
// convenience of keeping the contract value in `total_amount`. So the new plan
// covers only what is left, and the contract value survives in two columns:
//
//     original_total_amount = carried_amount_paid + total_amount
//
// Anything reporting contract value reads original_total_amount ?? total_amount
// (see contractValue below), so nothing has to know whether a plan has ever
// been restructured.
//
// ── WHY THE OLD ROWS ARE WAIVED, NOT DELETED ───────────────────────────────
// 'waived' is already in the schedule's status check constraint and is already
// excluded from every outstanding and overdue query. Deleting the rows would
// break the receipts that reference them. Waiving keeps the paper trail and
// stops the double count, which is exactly what is wanted.

const { supabaseAdmin } = require('../middleware/orgContext');
const { createPlanWithSchedule, buildSchedule } = require('./installmentService');
const { audit } = require('./auditService');

const toKobo = (naira) => Math.round(Number(naira || 0) * 100);
const toNaira = (kobo) => kobo / 100;

// The contract value of a plan, restructured or not. One helper so reporting
// never has to branch on it.
const contractValue = (plan) =>
  Number(plan?.original_total_amount ?? plan?.total_amount ?? 0);

// Everything the restructure needs to know, and the same numbers the preview
// shows — so what an operator is shown is what actually happens.
async function assess(orgId, reservationId) {
  const { data: reservation, error } = await supabaseAdmin
    .from('re_reservations')
    .select(`
      id, status, property_type,
      re_customers(id, full_name),
      re_units(unit_number, list_price, re_projects(name)),
      re_installment_plans(
        id, status, total_amount, original_total_amount, carried_amount_paid,
        number_of_installments, frequency, start_date,
        re_installment_schedule(id, installment_number, due_date, amount_due, status)
      )`)
    .eq('id', reservationId)
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) throw error;
  if (!reservation) return { notFound: true };

  const plans = Array.isArray(reservation.re_installment_plans)
    ? reservation.re_installment_plans
    : [reservation.re_installment_plans].filter(Boolean);

  const current = plans.find((p) => p.status !== 'superseded');
  if (!current) {
    return { noPlan: true, reservation };
  }

  const schedule = current.re_installment_schedule || [];
  const scheduleIds = schedule.map((row) => row.id);

  // Paid is read from the PAYMENTS, not from row status: a part-paid row is
  // still 'pending' but its money is real and must be carried forward.
  let paidKobo = 0;
  if (scheduleIds.length) {
    const { data: payments } = await supabaseAdmin
      .from('re_payments')
      .select('amount')
      .in('schedule_id', scheduleIds)
      .is('voided_at', null);
    paidKobo = (payments || []).reduce((sum, p) => sum + toKobo(p.amount), 0);
  }

  const contractKobo = toKobo(contractValue(current));
  // Carried forward includes anything a PREVIOUS restructure already carried,
  // or a second restructure would forget the first one's payments.
  const alreadyCarriedKobo = toKobo(current.carried_amount_paid);
  const totalPaidKobo = alreadyCarriedKobo + paidKobo;
  const remainingKobo = Math.max(0, contractKobo - totalPaidKobo);

  return {
    reservation,
    current,
    schedule,
    paid_on_this_plan: toNaira(paidKobo),
    total_paid: toNaira(totalPaidKobo),
    contract_value: toNaira(contractKobo),
    remaining: toNaira(remainingKobo),
    unpaid_rows: schedule.filter((r) => r.status !== 'paid').length,
    paid_rows: schedule.filter((r) => r.status === 'paid').length,
  };
}

// `preview` builds the proposed schedule WITHOUT writing anything, so the
// operator sees the actual dates and amounts before agreeing them with a buyer
// on the phone. Same function that will build the real thing.
function preview(remaining, { numberOfInstallments, frequency, startDate }) {
  return buildSchedule({
    totalAmount: remaining,
    numberOfInstallments,
    frequency,
    startDate,
  });
}

async function restructure(req, reservationId, {
  numberOfInstallments,
  frequency = 'monthly',
  startDate,
  reason = null,
}) {
  const orgId = req.orgId;
  const state = await assess(orgId, reservationId);

  if (state.notFound) return { notFound: true };
  if (state.noPlan) {
    throw Object.assign(
      new Error('This reservation has no payment plan to restructure. Create one instead.'),
      { statusCode: 409 }
    );
  }
  if (state.remaining <= 0) {
    throw Object.assign(
      new Error('This plan is fully paid — there is nothing left to reschedule.'),
      { statusCode: 409 }
    );
  }
  if (state.reservation.status === 'cancelled') {
    throw Object.assign(
      new Error('This reservation is cancelled. Reinstate it before restructuring the plan.'),
      { statusCode: 409 }
    );
  }
  // Rentals have their own renegotiation path (rentalService.renewTenancy)
  // for a reason: it deliberately carries forward NO balance or
  // original_total_amount, because a lease renewal is a fresh term, not a
  // renegotiation of a debt. Restructuring a rental through this path would
  // set both anyway, corrupting the monthly-rent figure everything else
  // derives from (total_amount / number_of_installments) and leaving
  // tenancy_end_date pointing at a date the new schedule no longer agrees
  // with.
  if (state.reservation.property_type === 'rental') {
    throw Object.assign(
      new Error('This is a rental. Use "Renew tenancy" instead of restructuring a lease term.'),
      { statusCode: 409 }
    );
  }

  const old = state.current;

  // Validate the new terms BEFORE touching anything, so a bad request cannot
  // leave a superseded plan with no replacement — which would read to the
  // dashboard as a buyer who owes nothing.
  preview(state.remaining, { numberOfInstallments, frequency, startDate });

  // The old plan goes first. The unique index allows only one ACTIVE plan per
  // reservation, so the new insert would be refused while the old one is still
  // active.
  const { error: supersedeError } = await supabaseAdmin
    .from('re_installment_plans')
    .update({
      status: 'superseded',
      restructured_at: new Date().toISOString(),
      restructure_reason: reason,
    })
    .eq('id', old.id)
    .eq('organization_id', orgId);
  if (supersedeError) throw supersedeError;

  // Unpaid rows stop being owed. Paid rows and their payments are untouched.
  const { data: waived } = await supabaseAdmin
    .from('re_installment_schedule')
    .update({ status: 'waived' })
    .eq('plan_id', old.id)
    .eq('organization_id', orgId)
    .in('status', ['pending', 'overdue'])
    .select('id');

  let created;
  try {
    created = await createPlanWithSchedule(orgId, {
      reservationId,
      totalAmount: state.remaining,
      numberOfInstallments,
      frequency,
      startDate,
    });
  } catch (err) {
    // Put it back. A reservation whose only plan is superseded looks, to every
    // aggregate in the product, like a buyer with no obligations left.
    await supabaseAdmin
      .from('re_installment_plans')
      .update({ status: 'active', restructured_at: null, restructure_reason: null })
      .eq('id', old.id);

    if (waived?.length) {
      await supabaseAdmin
        .from('re_installment_schedule')
        .update({ status: 'pending' })
        .in('id', waived.map((r) => r.id));
    }
    throw err;
  }

  // Record what the contract was and what has been paid into it, so the new
  // plan alone answers "how much did this buyer agree to, and how far in are
  // they" without walking the chain.
  const { data: linked, error: linkError } = await supabaseAdmin
    .from('re_installment_plans')
    .update({
      original_total_amount: state.contract_value,
      carried_amount_paid: state.total_paid,
    })
    .eq('id', created.plan.id)
    .eq('organization_id', orgId)
    .select()
    .single();
  if (linkError) throw linkError;

  await supabaseAdmin
    .from('re_installment_plans')
    .update({ superseded_by: created.plan.id })
    .eq('id', old.id)
    .eq('organization_id', orgId);

  // A renegotiated schedule is a change to the commercial terms of a sale. It
  // is exactly the kind of thing a buyer later says they never agreed to.
  audit(req, {
    action: 'plan.restructured',
    entityType: 're_installment_plans',
    entityId: created.plan.id,
    summary: `Plan restructured for ${state.reservation.re_customers?.full_name || 'buyer'}: `
      + `₦${state.remaining.toLocaleString('en-NG')} over ${numberOfInstallments} ${frequency} installments `
      + `from ${startDate}${reason ? ` — ${reason}` : ''}`,
    metadata: {
      reservation_id: reservationId,
      superseded_plan_id: old.id,
      new_plan_id: created.plan.id,
      contract_value: state.contract_value,
      already_paid: state.total_paid,
      rescheduled: state.remaining,
      waived_rows: waived?.length || 0,
      previous_terms: {
        number_of_installments: old.number_of_installments,
        frequency: old.frequency,
        start_date: old.start_date,
      },
      reason,
    },
  });

  return {
    plan: linked,
    schedule: created.schedule,
    superseded_plan_id: old.id,
    carried_amount_paid: state.total_paid,
    contract_value: state.contract_value,
    waived_rows: waived?.length || 0,
  };
}

module.exports = { assess, preview, restructure, contractValue };
