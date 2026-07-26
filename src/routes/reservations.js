const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { createPlanWithSchedule } = require('../services/installmentService');
const router = express.Router();

const RESERVATION_STATUSES = ['reserved', 'confirmed', 'cancelled', 'completed'];

router.get('/', async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_reservations')
      .select('*, re_customers(full_name, phone), re_units(unit_number, list_price, re_projects(name)), re_installment_plans(id, total_amount, number_of_installments)')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });

    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Create reservation (+ optional installment plan) in one call.
// Body: { unit_id, customer_id, sales_rep_id?, plan?: { total_amount, number_of_installments, frequency, start_date } }
//
// DOUBLE ALLOCATION is the failure this endpoint exists to prevent — selling
// one unit to two buyers is the sin that costs a Nigerian developer their
// reputation. Reading the unit's status and then inserting would leave a
// window where two simultaneous requests both read 'available'. So the unit is
// CLAIMED with a conditional UPDATE: Postgres applies the status='available'
// predicate under row lock, exactly one caller gets a row back, and the loser
// gets a 409. A partial unique index (migrations/001) backs this up.
router.post('/', async (req, res, next) => {
  try {
    const { unit_id, customer_id, sales_rep_id, plan } = req.body || {};
    if (!unit_id || !customer_id) {
      return res.status(400).json({ error: 'unit_id and customer_id are required' });
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
        .insert({ organization_id: req.orgId, unit_id, customer_id, sales_rep_id: sales_rep_id || null })
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

    res.json(reservation);
  } catch (e) { next(e); }
});

module.exports = router;
