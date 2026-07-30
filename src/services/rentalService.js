// rentalService.js — the two things a rental needs that a sale does not:
// a reminder that the lease is ending, and a way to renew it.
//
// A rental's monthly-rent schedule is an installment plan in every sense the
// schema already understands: total_amount = monthly_rent × duration_months,
// number_of_installments = duration_months, frequency = 'monthly'.
// installmentService builds that schedule unmodified — this file adds only
// the two things specific to a LEASE rather than a SALE.
//
// ── checkTenancyRenewals() ──────────────────────────────────────────────────
// Run every morning (jobs/daily.js) alongside the other sweeps. 60 days before
// a tenancy's end date it files a TASK — source: 'ai', same as every other
// brief-driven recommendation — asking whether to renew or end the lease.
//
// It does not renew anything itself. Every AI output in this product is a
// proposal a human acts on (docs/AI_WORKFORCE.md); auto-extending a lease and
// its payment schedule is a commercial decision, not a reminder, and belongs
// on the other side of a "Renew tenancy" button a person clicks.
//
// ── renewTenancy() ──────────────────────────────────────────────────────────
// The action behind that button. Mirrors restructureService's supersede
// pattern (migrations/005 gave both the same active/superseded lifecycle) but
// is simpler in one important way: a restructure carries forward a BALANCE
// because it is renegotiating the same debt mid-term, while a renewal starts
// a brand new lease PERIOD — nothing is owed from period to period, so nothing
// is carried forward. The old plan, its schedule and its payments are left
// exactly as they were; a new plan is created for the new period; the
// reservation's tenancy_end_date is extended to match.

const { supabaseAdmin } = require('../middleware/orgContext');
const { createPlanWithSchedule, addMonthsUTC, parseDateUTC } = require('./installmentService');
const { lagosToday } = require('./overdueService');
const { auditSystem } = require('./auditService');
const { audit } = require('./auditService');

const RENEWAL_WINDOW_DAYS = 60;
const toISODate = (date) => date.toISOString().slice(0, 10);

// Pure, and exported so it is directly unit-testable rather than only
// reachable through the full (database-hitting) renewTenancy() — the same
// reason restructureService exports its own preview().
const rentTotalForPeriod = (monthlyRent, durationMonths) =>
  Math.round(Number(monthlyRent) * Number(durationMonths) * 100) / 100;

// The new tenancy_end_date is the whole point of "renew": start + duration
// months, i.e. the day the FOLLOWING term would begin. A 12-month lease
// starting 2026-01-01 ends 2027-01-01.
const computeNewTenancyEndDate = (startDate, durationMonths) =>
  toISODate(addMonthsUTC(parseDateUTC(startDate), Number(durationMonths)));

// What "Renew Unit B12 for Mrs Adeyemi" would need before a person clicks
// through: the current plan, whether it is really a rental, and today's rent.
async function assessTenancy(orgId, reservationId) {
  const { data: reservation, error } = await supabaseAdmin
    .from('re_reservations')
    .select(`
      id, status, property_type, tenancy_start_date, tenancy_end_date,
      re_customers(id, full_name),
      re_units(unit_number, re_projects(name)),
      re_installment_plans(
        id, status, total_amount, number_of_installments, frequency, start_date
      )`)
    .eq('id', reservationId)
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) throw error;
  if (!reservation) return { notFound: true };
  if (reservation.property_type !== 'rental') return { notRental: true, reservation };

  const plans = Array.isArray(reservation.re_installment_plans)
    ? reservation.re_installment_plans
    : [reservation.re_installment_plans].filter(Boolean);
  const current = plans.find((p) => p.status !== 'superseded') || null;

  return {
    reservation,
    current,
    currentMonthlyRent: current
      ? Math.round((Number(current.total_amount) / Number(current.number_of_installments)) * 100) / 100
      : null,
  };
}

// Renews a tenancy for `durationMonths` at `monthlyRent`, starting the day
// after the CURRENT tenancy_end_date unless a different startDate is given —
// a lease renews from when the old one ends, not from today, or a renewal
// signed two weeks early would shorten the tenant's paid-for period by two
// weeks.
async function renewTenancy(req, reservationId, { monthlyRent, durationMonths, startDate, reason = null }) {
  const orgId = req.orgId;
  const state = await assessTenancy(orgId, reservationId);

  if (state.notFound) return { notFound: true };
  if (state.notRental) {
    throw Object.assign(
      new Error('This reservation is not a rental — only rentals have a tenancy to renew.'),
      { statusCode: 409 }
    );
  }
  if (state.reservation.status === 'cancelled') {
    throw Object.assign(new Error('This reservation is cancelled.'), { statusCode: 409 });
  }
  if (!Number(monthlyRent) || monthlyRent <= 0) {
    throw Object.assign(new Error('monthly_rent must be a positive number'), { statusCode: 400 });
  }
  if (!Number.isInteger(Number(durationMonths)) || durationMonths < 1 || durationMonths > 120) {
    throw Object.assign(new Error('duration_months must be a whole number between 1 and 120'), { statusCode: 400 });
  }

  const effectiveStart = startDate
    || state.reservation.tenancy_end_date
    || lagosToday();

  const totalForPeriod = rentTotalForPeriod(monthlyRent, durationMonths);

  // Supersede the expiring plan FIRST — uniq_re_active_plan_per_reservation
  // (migrations/005) allows only one active plan, so the new one cannot be
  // created while the old one still holds that slot.
  if (state.current) {
    const { error: supersedeError } = await supabaseAdmin
      .from('re_installment_plans')
      .update({
        status: 'superseded',
        restructured_at: new Date().toISOString(),
        restructure_reason: reason || 'Tenancy renewed',
      })
      .eq('id', state.current.id)
      .eq('organization_id', orgId);
    if (supersedeError) throw supersedeError;
  }

  let created;
  try {
    created = await createPlanWithSchedule(orgId, {
      reservationId,
      totalAmount: totalForPeriod,
      numberOfInstallments: durationMonths,
      frequency: 'monthly',
      startDate: effectiveStart,
    });
  } catch (err) {
    // Put the old plan back — a reservation with no active plan reads, to
    // every aggregate in the product, as a tenant who owes nothing.
    if (state.current) {
      await supabaseAdmin
        .from('re_installment_plans')
        .update({ status: 'active', restructured_at: null, restructure_reason: null })
        .eq('id', state.current.id);
    }
    throw err;
  }

  if (state.current) {
    await supabaseAdmin
      .from('re_installment_plans')
      .update({ superseded_by: created.plan.id })
      .eq('id', state.current.id)
      .eq('organization_id', orgId);
  }

  // Deliberately NOT original_total_amount / carried_amount_paid: those exist
  // to reconstruct a mid-term restructure's contract value, and a renewal is
  // not that — it is a fresh, separate lease term with its own full value.

  const newEndDate = computeNewTenancyEndDate(effectiveStart, durationMonths);

  const { data: updatedReservation, error: resErr } = await supabaseAdmin
    .from('re_reservations')
    .update({
      tenancy_start_date: state.reservation.tenancy_start_date || effectiveStart,
      tenancy_end_date: newEndDate,
    })
    .eq('id', reservationId)
    .eq('organization_id', orgId)
    .select()
    .single();
  if (resErr) throw resErr;

  // A renewed lease is a live tenant again, not one whose file was flagged for
  // a decision the human has just made.
  await closeRenewalTask(orgId, reservationId);

  audit(req, {
    action: 'tenancy.renewed',
    entityType: 're_reservations',
    entityId: reservationId,
    summary: `Tenancy renewed for ${state.reservation.re_customers?.full_name || 'tenant'} — `
      + `₦${Number(monthlyRent).toLocaleString('en-NG')}/month for ${durationMonths} months, `
      + `new end date ${newEndDate}${reason ? ` — ${reason}` : ''}`,
    metadata: {
      previous_plan_id: state.current?.id || null,
      new_plan_id: created.plan.id,
      monthly_rent: Number(monthlyRent),
      duration_months: Number(durationMonths),
      start_date: effectiveStart,
      new_tenancy_end_date: newEndDate,
      reason,
    },
  });

  return {
    reservation: updatedReservation,
    plan: created.plan,
    schedule: created.schedule,
    superseded_plan_id: state.current?.id || null,
    new_tenancy_end_date: newEndDate,
  };
}

// Ending the tenancy (the other side of "renew or end") is just the existing
// reservation-status transition — PATCH /reservations/:id/status with
// status: 'completed' or 'cancelled' already frees or retires the unit. No
// rental-specific endpoint is needed for "end"; only "renew" is new work.

// ── The morning sweep ────────────────────────────────────────────────────
// Files one task per rental reservation whose tenancy_end_date falls inside
// the next 60 days, and does not re-file one that is still open — the same
// title-match dedupe aiBrief.js uses for its own recommendations, so
// re-running the sweep (or running it on a day nothing changed) does not
// multiply the task.
async function checkTenancyRenewals(orgId = null) {
  const today = lagosToday();
  const horizon = new Date(Date.parse(today) + RENEWAL_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  let query = supabaseAdmin
    .from('re_reservations')
    .select(`
      id, organization_id, tenancy_end_date,
      re_customers(full_name),
      re_units(unit_number, re_projects(name))`)
    .eq('property_type', 'rental')
    .in('status', ['reserved', 'confirmed'])
    .not('tenancy_end_date', 'is', null)
    .lte('tenancy_end_date', horizon);
  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query;
  if (error) throw error;

  let filed = 0;

  for (const reservation of data || []) {
    const title = renewalTaskTitle(reservation);

    const { data: existing } = await supabaseAdmin
      .from('re_tasks')
      .select('id')
      .eq('organization_id', reservation.organization_id)
      .eq('title', title)
      .eq('status', 'open')
      .eq('source', 'ai')
      .limit(1)
      .maybeSingle();
    if (existing) continue;

    const { error: insertError } = await supabaseAdmin.from('re_tasks').insert({
      organization_id: reservation.organization_id,
      title,
      notes: `Tenancy ends ${reservation.tenancy_end_date}. Decide whether to renew — use "Renew tenancy" on the `
        + `reservation to set a new period — or end it and return the unit to the market.`,
      due_date: reservation.tenancy_end_date,
      related_reservation_id: reservation.id,
      source: 'ai',
    });
    if (insertError) {
      console.warn('[rental] could not file renewal task:', insertError.message);
      continue;
    }
    filed += 1;

    await auditSystem({
      orgId: reservation.organization_id,
      actorKind: 'system',
      action: 'tenancy.renewal_flagged',
      entityType: 're_reservations',
      entityId: reservation.id,
      summary: `Tenancy for ${reservation.re_customers?.full_name || 'tenant'} expires `
        + `${reservation.tenancy_end_date} — flagged for renewal decision`,
      metadata: { tenancy_end_date: reservation.tenancy_end_date },
    });
  }

  return { evaluated: (data || []).length, filed };
}

// Once a human has renewed (or ended) the tenancy, the open reminder task is
// stale — closing it here means the task list reflects the decision instead
// of asking about it forever.
async function closeRenewalTask(orgId, reservationId) {
  try {
    await supabaseAdmin
      .from('re_tasks')
      .update({ status: 'done' })
      .eq('organization_id', orgId)
      .eq('related_reservation_id', reservationId)
      .eq('source', 'ai')
      .eq('status', 'open')
      .ilike('title', 'Tenancy renewal%');
  } catch (err) {
    console.warn('[rental] could not close the renewal task:', err.message);
  }
}

const renewalTaskTitle = (reservation) => {
  const unit = reservation.re_units?.unit_number
    ? `Unit ${reservation.re_units.unit_number}`
    : 'a unit';
  const tenant = reservation.re_customers?.full_name || 'the tenant';
  return `Tenancy renewal — ${unit} (${tenant}) expires ${reservation.tenancy_end_date}`;
};

module.exports = {
  assessTenancy, renewTenancy, checkTenancyRenewals, RENEWAL_WINDOW_DAYS,
  rentTotalForPeriod, computeNewTenancyEndDate,
};
