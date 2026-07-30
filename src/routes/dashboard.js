const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday } = require('../services/overdueService');
const { describeStage } = require('../services/escalationService');
const router = express.Router();

// One endpoint, one fetch, the whole dashboard. The CEO screen is the product's
// daily habit — it should never be five spinners.
//
// `?project_id=` scopes everything below to a single development. A developer
// running Lekki Gardens, Abuja Hills and Port Harcourt Terrace sees one
// combined "collected this month" without it, and cannot tell which of the
// three has the problem — which is the only thing they wanted to know when
// they opened the page.
router.get('/', async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const projectId = req.query.project_id || null;
    const today = lagosToday();
    const monthStart = today.slice(0, 8) + '01';
    const in7 = new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10);

    // Scoping money to a project, and splitting it into sales vs rental
    // income, both mean walking payment → schedule → plan → reservation →
    // unit → project. That join used to be built only when a project was
    // actually selected; property_type now needs it every time, so the
    // unscoped path pays that one join cost unconditionally.
    let paymentsQuery = supabaseAdmin.from('re_payments')
      .select('amount, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(property_type, re_units!inner(project_id))))')
      .eq('organization_id', orgId)
      .gte('paid_at', monthStart);

    let scheduleQuery = supabaseAdmin.from('re_installment_schedule')
      .select(projectId
        ? 'amount_due, due_date, status, re_installment_plans!inner(re_reservations!inner(re_units!inner(project_id)))'
        : 'amount_due, due_date, status')
      .eq('organization_id', orgId)
      .in('status', ['pending', 'overdue']);

    let unitsQuery = supabaseAdmin.from('re_units')
      .select('status').eq('organization_id', orgId);

    if (projectId) {
      paymentsQuery = paymentsQuery.eq(
        're_installment_schedule.re_installment_plans.re_reservations.re_units.project_id', projectId);
      scheduleQuery = scheduleQuery.eq(
        're_installment_plans.re_reservations.re_units.project_id', projectId);
      unitsQuery = unitsQuery.eq('project_id', projectId);
    }

    const [payments, schedule, units, tasks, brief, projects] = await Promise.all([
      paymentsQuery,
      scheduleQuery,
      unitsQuery,
      supabaseAdmin.from('re_tasks')
        .select('id, source').eq('organization_id', orgId).eq('status', 'open'),
      supabaseAdmin.from('re_ai_briefs')
        .select('summary, payload, brief_date, generated_by').eq('organization_id', orgId)
        .order('brief_date', { ascending: false }).limit(1).maybeSingle(),
      // The project list travels with the dashboard so the filter control has
      // something to render without a second request on first paint.
      supabaseAdmin.from('re_projects')
        .select('id, name, location, status').eq('organization_id', orgId).order('name'),
    ]);

    for (const result of [payments, schedule, units, tasks, brief, projects]) {
      if (result.error) throw result.error;
    }

    const scheduleRows = schedule.data || [];
    const overdueRows = scheduleRows.filter((s) => s.status === 'overdue');
    const unitRows = units.data || [];
    const taskRows = tasks.data || [];
    const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

    // Two revenue streams under one roof read as one number without this —
    // a developer running both a sales book and a rental portfolio cannot
    // otherwise tell whether this month's collections came from buyers
    // paying down installments or tenants paying rent.
    const paymentRows = payments.data || [];
    const isRentalPayment = (row) => row.re_installment_schedule
      ?.re_installment_plans?.re_reservations?.property_type === 'rental';
    const rentalPayments = paymentRows.filter(isRentalPayment);
    const salesPayments = paymentRows.filter((row) => !isRentalPayment(row));

    res.json({
      project_id: projectId,
      projects: projects.data || [],
      collected_this_month: sum(paymentRows, 'amount'),
      collected_sales_this_month: sum(salesPayments, 'amount'),
      collected_rental_this_month: sum(rentalPayments, 'amount'),
      outstanding_total: sum(scheduleRows, 'amount_due'),
      overdue: {
        count: overdueRows.length,
        amount: sum(overdueRows, 'amount_due'),
      },
      due_next_7_days: sum(
        scheduleRows.filter((s) => s.status === 'pending' && s.due_date >= today && s.due_date <= in7),
        'amount_due'
      ),
      units: {
        available: unitRows.filter((u) => u.status === 'available').length,
        reserved: unitRows.filter((u) => u.status === 'reserved').length,
        sold: unitRows.filter((u) => u.status === 'sold').length,
      },
      open_tasks: {
        total: taskRows.length,
        from_ai: taskRows.filter((t) => t.source === 'ai').length,
      },
      // The brief stays workspace-wide even with a project filter on: it is
      // written once a morning against the whole book, and quietly showing a
      // filtered version of it would misrepresent what the AI actually read.
      latest_brief: brief.data || null,
    });
  } catch (e) { next(e); }
});

// At-risk customers: 2+ overdue installments, worst first.
// This is the list a sales manager actually works through in the morning.
router.get('/at-risk', async (req, res, next) => {
  try {
    const today = lagosToday();

    // Scoped by the schedule row's own organization_id rather than through the
    // join path — the column is denormalized so org filtering never depends on
    // a nested filter expression remaining correct.
    let query = supabaseAdmin
      .from('re_installment_schedule')
      .select(`
        id, amount_due, due_date,
        re_installment_plans!inner(
          re_reservations!inner(
            id, escalation_stage,
            re_customers(id, full_name, phone, email),
            re_units(unit_number, project_id, re_projects(id, name))
          )
        )`)
      .eq('organization_id', req.orgId)
      .eq('status', 'overdue');

    if (req.query.project_id) {
      query = query.eq('re_installment_plans.re_reservations.re_units.project_id', req.query.project_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    const byCustomer = new Map();
    for (const row of data || []) {
      const reservation = row.re_installment_plans?.re_reservations;
      const customer = reservation?.re_customers;
      if (!customer) continue;

      const entry = byCustomer.get(customer.id) || {
        customer,
        unit: reservation.re_units,
        reservation_id: reservation.id,
        escalation_stage: reservation.escalation_stage || 'none',
        overdue_count: 0,
        overdue_amount: 0,
        oldest_due: row.due_date,
        // Carried so the UI can offer "log a promise" against the specific
        // installment rather than making the rep go hunting for it.
        oldest_schedule_id: row.id,
        schedule_ids: [],
      };

      entry.overdue_count += 1;
      entry.overdue_amount += Number(row.amount_due);
      entry.schedule_ids.push(row.id);
      if (row.due_date < entry.oldest_due) {
        entry.oldest_due = row.due_date;
        entry.oldest_schedule_id = row.id;
      }
      byCustomer.set(customer.id, entry);
    }

    const atRisk = [...byCustomer.values()].filter((c) => c.overdue_count >= 2);

    // Promises turn "two months behind" into "two months behind AND broke a
    // promise on the 15th" — a different conversation, and it belongs on the
    // same card rather than on a screen nobody opens.
    const scheduleIds = atRisk.flatMap((c) => c.schedule_ids);
    const promiseBySchedule = new Map();
    if (scheduleIds.length) {
      const { data: promises } = await supabaseAdmin
        .from('re_payment_promises')
        .select('schedule_id, promised_date, promised_amount, status, spoke_to')
        .eq('organization_id', req.orgId)
        .in('schedule_id', scheduleIds)
        .in('status', ['open', 'broken']);
      for (const promise of promises || []) promiseBySchedule.set(promise.schedule_id, promise);
    }

    res.json(atRisk
      .map((c) => {
        const promise = c.schedule_ids.map((id) => promiseBySchedule.get(id)).find(Boolean) || null;
        const stage = describeStage(c.escalation_stage);
        return {
          ...c,
          days_late: Math.max(0, Math.round((Date.parse(today) - Date.parse(c.oldest_due)) / 86_400_000)),
          promise,
          escalation: { stage: stage.key, label: stage.label, tone: stage.tone },
        };
      })
      // A broken promise outranks a bigger number. Somebody gave their word on
      // a date and did not keep it; that is the call to make first.
      .sort((a, b) => {
        const brokenDiff = Number(b.promise?.status === 'broken') - Number(a.promise?.status === 'broken');
        return brokenDiff || b.overdue_amount - a.overdue_amount;
      }));
  } catch (e) { next(e); }
});

module.exports = router;
