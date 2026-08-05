const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission, isOwnRecordsOnly, salesRepIdsFor, MATCHES_NOTHING } = require('../middleware/rbac');
const { canAccess } = require('../services/permissions');
const { createPlanWithSchedule } = require('../services/installmentService');
const { assess, preview, restructure } = require('../services/restructureService');
const { assessTenancy, renewTenancy } = require('../services/rentalService');
const { audit } = require('../services/auditService');
const router = express.Router();

// Documentation has reservations.read (permissions.js) — "which unit, which
// installment, its status and date, no naira figure" — but this list route
// never applied financial.view's strip, unlike the identical rule
// routes/customers.js already enforces on the single-buyer view. Mutates in
// place; matches customers.js's stripFinancials exactly, just applied per
// row of a list instead of once per buyer.
function stripFinancials(reservation) {
  if (reservation.re_units) reservation.re_units.list_price = null;
  const plans = Array.isArray(reservation.re_installment_plans)
    ? reservation.re_installment_plans
    : [reservation.re_installment_plans].filter(Boolean);
  for (const plan of plans) plan.total_amount = null;
}

const RESERVATION_STATUSES = ['reserved', 'confirmed', 'cancelled', 'completed'];

// Off-plan and outright are the product's original two, and stay the default
// so every existing integration and every existing reservation is unaffected.
// Rental is additive: a third kind of reservation, not a replacement for the
// other two.
const PROPERTY_TYPES = ['off_plan', 'outright', 'rental'];

router.get('/', requirePermission('reservations.read'), async (req, res, next) => {
  try {
    // Unbounded until now — every reservation ever made, on every load of
    // this screen, for a developer years into selling several projects.
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    let query = supabaseAdmin
      .from('re_reservations')
      .select('*, re_customers(full_name, phone), re_units(unit_number, list_price, re_projects(name)), re_installment_plans(id, total_amount, number_of_installments)')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.property_type) query = query.eq('property_type', req.query.property_type);

    // A Sales Executive sees only their own book — everyone else who can
    // open this screen at all (owner, sales director, documentation) sees
    // every reservation.
    if (isOwnRecordsOnly(req.orgRole)) {
      const repIds = await salesRepIdsFor(req);
      query = query.in('sales_rep_id', repIds.length ? repIds : [MATCHES_NOTHING]);
    }

    const { data, error } = await query;
    if (error) throw error;

    if (!canAccess(req.orgRole, 'financial.view')) {
      for (const reservation of data || []) stripFinancials(reservation);
    }

    res.json(data);
  } catch (e) { next(e); }
});

// Create reservation (+ optional installment plan) in one call.
// Body: { unit_id, customer_id, sales_rep_id?, property_type?,
//         tenancy_start_date?, tenancy_end_date?,
//         plan?: { total_amount, number_of_installments, frequency, start_date } }
//
// DOUBLE ALLOCATION is the failure this endpoint exists to prevent — selling
// one unit to two buyers is the sin that costs a Nigerian developer their
// reputation. Reading the unit's status and then inserting would leave a
// window where two simultaneous requests both read 'available'. So the unit is
// CLAIMED with a conditional UPDATE: Postgres applies the status='available'
// predicate under row lock, exactly one caller gets a row back, and the loser
// gets a 409. A partial unique index (migrations/001) backs this up.
//
// A RENTAL is not a different endpoint. Its monthly-rent schedule is an
// installment plan in every sense installmentService already understands one
// — total_amount = monthly rent × months, number_of_installments = months,
// frequency = 'monthly'. The frontend does that multiplication before it
// calls here (screens.js), so this handler never needs to know "rent" as a
// concept distinct from "plan".
router.post('/', requirePermission('reservations.create'), async (req, res, next) => {
  try {
    const { unit_id, customer_id, plan } = req.body || {};
    let { sales_rep_id } = req.body || {};
    const property_type = req.body?.property_type || 'off_plan';
    const tenancy_start_date = req.body?.tenancy_start_date || null;
    const tenancy_end_date = req.body?.tenancy_end_date || null;

    // A Sales Executive's own reservations are what makes them theirs — the
    // filter above reads sales_rep_id, so a rep who could set it to anything
    // (a colleague's id, or leave it blank) could hand their own sale away or
    // vanish it from their own book. Their identity wins over whatever the
    // request sent, and if they have no re_sales_reps row yet — invited but
    // not yet tagged as a rep by an owner or director — there is nothing to
    // attach the sale to.
    if (isOwnRecordsOnly(req.orgRole)) {
      const repIds = await salesRepIdsFor(req);
      if (!repIds.length) {
        return res.status(403).json({
          error: 'You have not been set up as a sales rep yet — ask an owner or the Head of Sales to add you.',
        });
      }
      [sales_rep_id] = repIds;
    }

    if (!unit_id || !customer_id) {
      return res.status(400).json({ error: 'unit_id and customer_id are required' });
    }
    if (!PROPERTY_TYPES.includes(property_type)) {
      return res.status(400).json({ error: `property_type must be one of: ${PROPERTY_TYPES.join(', ')}` });
    }
    if (property_type === 'rental' && !tenancy_start_date) {
      return res.status(400).json({ error: 'A rental reservation needs a tenancy_start_date.' });
    }
    if (tenancy_end_date && tenancy_start_date && tenancy_end_date <= tenancy_start_date) {
      return res.status(400).json({ error: 'tenancy_end_date must be after tenancy_start_date.' });
    }

    const [{ data: unit }, { data: customer }] = await Promise.all([
      supabaseAdmin.from('re_units').select('id, status')
        .eq('id', unit_id).eq('organization_id', req.orgId).maybeSingle(),
      supabaseAdmin.from('re_customers').select('id')
        .eq('id', customer_id).eq('organization_id', req.orgId).maybeSingle(),
    ]);

    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Fetched WITH commission_rate, not just id — the rate is snapshotted onto
    // the reservation below (migrations/020) so a later change to this rep's
    // rate does not change what THIS deal pays out on installments still to
    // come, same reasoning as commissionService's per-payment copy, just at
    // the reservation instead of the payment.
    let repCommissionRate = null;
    if (sales_rep_id) {
      const { data: rep } = await supabaseAdmin.from('re_sales_reps').select('id, commission_rate')
        .eq('id', sales_rep_id).eq('organization_id', req.orgId).maybeSingle();
      if (!rep) return res.status(404).json({ error: 'Sales rep not found' });
      repCommissionRate = rep.commission_rate;
    }

    // Reject bad plan input before touching the unit, so a validation error
    // can't leave a unit reserved with no reservation behind it.
    if (plan) {
      const { total_amount, number_of_installments, start_date } = plan;
      if (total_amount == null || number_of_installments == null || !start_date) {
        return res.status(400).json({
          error: 'plan requires total_amount, number_of_installments and start_date',
        });
      }
    }

    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from('re_units')
      .update({ status: 'reserved' })
      .eq('id', unit_id)
      .eq('organization_id', req.orgId)
      .eq('status', 'available')
      .select('id');
    if (claimErr) throw claimErr;

    if (!claimed || claimed.length === 0) {
      return res.status(409).json({
        error: `Unit is already ${unit.status}. Double allocation blocked.`,
      });
    }

    const releaseUnit = () =>
      supabaseAdmin.from('re_units').update({ status: 'available' }).eq('id', unit_id);

    let reservation;
    try {
      const { data, error } = await supabaseAdmin
        .from('re_reservations')
        .insert({
          organization_id: req.orgId, unit_id, customer_id, sales_rep_id: sales_rep_id || null,
          commission_rate: repCommissionRate,
          property_type, tenancy_start_date, tenancy_end_date,
        })
        .select()
        .single();
      if (error) throw error;
      reservation = data;
    } catch (err) {
      await releaseUnit();
      // 23505 = the partial unique index caught a live reservation we didn't
      // see, i.e. the same double-allocation attempt from a different angle.
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Unit already has an active reservation. Double allocation blocked.' });
      }
      throw err;
    }

    let planResult = null;
    if (plan) {
      try {
        planResult = await createPlanWithSchedule(req.orgId, {
          reservationId: reservation.id,
          totalAmount: plan.total_amount,
          numberOfInstallments: plan.number_of_installments,
          frequency: plan.frequency,
          startDate: plan.start_date,
        });
      } catch (err) {
        // Unwind fully: a reservation with a broken payment plan is worse than
        // no reservation, because the schedule is what everything else counts.
        // A hard delete, not a soft one — this row is seconds old, has no
        // children, and nobody has ever seen it; softDelete.js's cascade
        // machinery exists for records that were real, not for undoing a
        // request that didn't finish. Audited anyway, so "a reservation was
        // created and destroyed in the same request" has a trace rather than
        // being the one hard delete in this product with none.
        await supabaseAdmin.from('re_reservations').delete().eq('id', reservation.id);
        await releaseUnit();
        audit(req, {
          action: 'reservation.rollback',
          entityType: 're_reservations',
          entityId: reservation.id,
          summary: `Reservation for unit ${unit_id} rolled back — plan creation failed: ${err.message}`,
          metadata: { unit_id, customer_id, reason: err.message },
        });
        // installmentService's own validation (bad total_amount, a start_date
        // that doesn't parse) throws a plain Error with a message written for
        // this response. A raw Postgres/PostgREST error always carries a
        // `.code` — forwarding ITS message would hand the caller a constraint
        // or column name from the schema instead of something they can act on.
        return res.status(400).json({
          error: err.code ? 'Could not build the installment schedule' : err.message,
        });
      }
    }

    // Who allocated which unit to whom is the single most disputed fact in
    // Nigerian off-plan sales. It gets written down.
    audit(req, {
      action: 'reservation.created',
      entityType: 're_reservations',
      entityId: reservation.id,
      summary: property_type === 'rental'
        ? `Unit let to a tenant${planResult ? ` at ₦${(plan.total_amount / plan.number_of_installments).toLocaleString('en-NG')}/month` : ''}`
        : `Unit reserved for a buyer${planResult ? ` on a ${plan.number_of_installments}-installment plan` : ' (no payment plan)'}`,
      metadata: {
        unit_id,
        customer_id,
        sales_rep_id: sales_rep_id || null,
        property_type,
        tenancy_start_date,
        tenancy_end_date,
        plan: planResult ? {
          total_amount: plan.total_amount,
          number_of_installments: plan.number_of_installments,
          frequency: plan.frequency || 'monthly',
          start_date: plan.start_date,
        } : null,
      },
    });

    res.status(201).json({ reservation, plan: planResult });
  } catch (e) { next(e); }
});

router.patch('/:id/status', requirePermission('reservations.updateStatus'), async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!RESERVATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${RESERVATION_STATUSES.join(', ')}` });
    }

    const { data: existing } = await supabaseAdmin
      .from('re_reservations')
      .select('id, unit_id, status, property_type, sales_rep_id')
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Reservation not found' });

    // Same boundary as the list above: a Sales Executive may change the
    // status of their own sale, never a colleague's.
    if (isOwnRecordsOnly(req.orgRole)) {
      const repIds = await salesRepIdsFor(req);
      if (!existing.sales_rep_id || !repIds.includes(existing.sales_rep_id)) {
        return res.status(404).json({ error: 'Reservation not found' });
      }
    }

    const { data: reservation, error } = await supabaseAdmin
      .from('re_reservations')
      .update({ status })
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .single();
    if (error) {
      // The partial unique index (one live reservation per unit) is what
      // actually blocks a double allocation here — reactivating a cancelled
      // reservation (or any transition off it) races the same unit being
      // claimed by someone else in the meantime, the same conflict
      // POST /reservations already handles explicitly rather than as a raw 500.
      if (error.code === '23505') {
        return res.status(409).json({
          error: 'This unit already has another active reservation. Double allocation blocked.',
        });
      }
      throw error;
    }

    // Unit status follows the reservation: cancelling puts the unit back on
    // the market, completing takes it off for good — UNLESS this is a
    // rental, where "completed" means a tenancy ended, not a unit sold. A
    // rental unit is never "sold" by this transition, and mapping it to
    // 'sold' would permanently retire it from ever being let again, since
    // only an 'available' unit can be claimed by a new reservation.
    const unitStatus = status === 'cancelled' ? 'available'
      : status === 'completed' ? (existing.property_type === 'rental' ? 'available' : 'sold')
      : 'reserved';

    const { error: unitErr } = await supabaseAdmin
      .from('re_units')
      .update({ status: unitStatus })
      .eq('id', reservation.unit_id)
      .eq('organization_id', req.orgId);
    if (unitErr) throw unitErr;

    audit(req, {
      action: `reservation.${status}`,
      entityType: 're_reservations',
      entityId: reservation.id,
      summary: `Reservation moved from ${existing.status} to ${status}; unit marked ${unitStatus}`,
      metadata: { from: existing.status, to: status, unit_id: reservation.unit_id, unit_status: unitStatus },
    });

    res.json(reservation);
  } catch (e) { next(e); }
});

// ── Plan restructuring ─────────────────────────────────────────────────────
// The alternative to cancelling. A buyer three installments down renegotiates
// terms; before this the only route was to cancel the reservation and re-enter
// it, losing the payment history.

// What would a restructure look like? Nothing is written, so this is safe to
// call while the rep is still on the phone agreeing the terms.
router.get('/:id/restructure', requirePermission('reservations.restructure'), async (req, res, next) => {
  try {
    const state = await assess(req.orgId, req.params.id);
    if (state.notFound) return res.status(404).json({ error: 'Reservation not found' });
    if (state.noPlan) {
      return res.status(409).json({ error: 'This reservation has no payment plan to restructure.' });
    }

    const response = {
      contract_value: state.contract_value,
      total_paid: state.total_paid,
      remaining: state.remaining,
      paid_rows: state.paid_rows,
      unpaid_rows: state.unpaid_rows,
      current: {
        id: state.current.id,
        number_of_installments: state.current.number_of_installments,
        frequency: state.current.frequency,
        start_date: state.current.start_date,
      },
    };

    // Proposed terms in the query string produce the actual dates and amounts,
    // built by the same function that will build the real schedule.
    const count = Number(req.query.number_of_installments);
    if (count && req.query.start_date) {
      try {
        response.proposed = preview(state.remaining, {
          numberOfInstallments: count,
          frequency: req.query.frequency || 'monthly',
          startDate: req.query.start_date,
        });
      } catch (err) {
        response.proposed_error = err.message;
      }
    }

    res.json(response);
  } catch (e) { next(e); }
});

router.post('/:id/restructure', requirePermission('reservations.restructure'), async (req, res, next) => {
  try {
    const { number_of_installments, frequency, start_date, reason } = req.body || {};
    if (!number_of_installments || !start_date) {
      return res.status(400).json({
        error: 'number_of_installments and start_date are required',
      });
    }

    const result = await restructure(req, req.params.id, {
      numberOfInstallments: Number(number_of_installments),
      frequency: frequency || 'monthly',
      startDate: start_date,
      reason: reason || null,
    });

    if (result.notFound) return res.status(404).json({ error: 'Reservation not found' });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// ── Tenancy renewal ─────────────────────────────────────────────────────────
// The rental equivalent of restructuring: 60 days before a lease ends the
// morning sweep (rentalService.checkTenancyRenewals) files a task asking
// whether to renew or end it. This is the "renew" side of that decision —
// "end" is just the existing status transition above (cancelled/completed).

router.get('/:id/renew-tenancy', requirePermission('reservations.renewTenancy'), async (req, res, next) => {
  try {
    const state = await assessTenancy(req.orgId, req.params.id);
    if (state.notFound) return res.status(404).json({ error: 'Reservation not found' });
    if (state.notRental) {
      return res.status(409).json({ error: 'This reservation is not a rental — only rentals have a tenancy to renew.' });
    }

    res.json({
      current_monthly_rent: state.currentMonthlyRent,
      current_tenancy_end_date: state.reservation.tenancy_end_date,
      has_active_plan: Boolean(state.current),
    });
  } catch (e) { next(e); }
});

router.post('/:id/renew-tenancy', requirePermission('reservations.renewTenancy'), async (req, res, next) => {
  try {
    const { monthly_rent, duration_months, start_date, reason } = req.body || {};
    if (!monthly_rent || !duration_months) {
      return res.status(400).json({ error: 'monthly_rent and duration_months are required' });
    }

    const result = await renewTenancy(req, req.params.id, {
      monthlyRent: Number(monthly_rent),
      durationMonths: Number(duration_months),
      startDate: start_date || null,
      reason: reason || null,
    });

    if (result.notFound) return res.status(404).json({ error: 'Reservation not found' });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

module.exports = router;
