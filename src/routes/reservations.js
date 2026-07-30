const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { createPlanWithSchedule } = require('../services/installmentService');
const { assess, preview, restructure } = require('../services/restructureService');
const { assessTenancy, renewTenancy } = require('../services/rentalService');
const { audit } = require('../services/auditService');
const router = express.Router();

const RESERVATION_STATUSES = ['reserved', 'confirmed', 'cancelled', 'completed'];

// Off-plan and outright are the product's original two, and stay the default
// so every existing integration and every existing reservation is unaffected.
// Rental is additive: a third kind of reservation, not a replacement for the
// other two.
const PROPERTY_TYPES = ['off_plan', 'outright', 'rental'];

router.get('/', async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_reservations')
      .select('*, re_customers(full_name, phone), re_units(unit_number, list_price, re_projects(name)), re_installment_plans(id, total_amount, number_of_installments)')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });

    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.property_type) query = query.eq('property_type', req.query.property_type);

    const { data, error } = await query;
    if (error) throw error;
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
router.post('/', async (req, res, next) => {
  try {
    const { unit_id, customer_id, sales_rep_id, plan } = req.body || {};
    const property_type = req.body?.property_type || 'off_plan';
    const tenancy_start_date = req.body?.tenancy_start_date || null;
    const tenancy_end_date = req.body?.tenancy_end_date || null;

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

    if (sales_rep_id) {
      const { data: rep } = await supabaseAdmin.from('re_sales_reps').select('id')
        .eq('id', sales_rep_id).eq('organization_id', req.orgId).maybeSingle();
      if (!rep) return res.status(404).json({ error: 'Sales rep not found' });
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
        await supabaseAdmin.from('re_reservations').delete().eq('id', reservation.id);
        await releaseUnit();
        return res.status(400).json({ error: err.message || 'Could not build the installment schedule' });
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

router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!RESERVATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${RESERVATION_STATUSES.join(', ')}` });
    }

    const { data: existing } = await supabaseAdmin
      .from('re_reservations')
      .select('id, unit_id, status')
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Reservation not found' });

    const { data: reservation, error } = await supabaseAdmin
      .from('re_reservations')
      .update({ status })
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .single();
    if (error) throw error;

    // Unit status follows the reservation: cancelling puts the unit back on
    // the market, completing takes it off for good.
    const unitStatus = status === 'cancelled' ? 'available'
      : status === 'completed' ? 'sold'
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
router.get('/:id/restructure', async (req, res, next) => {
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

router.post('/:id/restructure', async (req, res, next) => {
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

router.get('/:id/renew-tenancy', async (req, res, next) => {
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

router.post('/:id/renew-tenancy', async (req, res, next) => {
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
