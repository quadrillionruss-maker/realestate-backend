const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday } = require('../services/overdueService');
const router = express.Router();

// One endpoint, one fetch, the whole dashboard. The CEO screen is the product's
// daily habit — it should never be five spinners.
router.get('/', async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const today = lagosToday();
    const monthStart = today.slice(0, 8) + '01';
    const in7 = new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10);

    const [payments, schedule, units, tasks, brief] = await Promise.all([
      supabaseAdmin.from('re_payments')
        .select('amount').eq('organization_id', orgId).gte('paid_at', monthStart),
      supabaseAdmin.from('re_installment_schedule')
        .select('amount_due, due_date, status').eq('organization_id', orgId).in('status', ['pending', 'overdue']),
      supabaseAdmin.from('re_units')
        .select('status').eq('organization_id', orgId),
      supabaseAdmin.from('re_tasks')
        .select('id, source').eq('organization_id', orgId).eq('status', 'open'),
      supabaseAdmin.from('re_ai_briefs')
        .select('summary, payload, brief_date, generated_by').eq('organization_id', orgId)
        .order('brief_date', { ascending: false }).limit(1).maybeSingle(),
    ]);

    for (const result of [payments, schedule, units, tasks, brief]) {
      if (result.error) throw result.error;
    }

    const scheduleRows = schedule.data || [];
    const overdueRows = scheduleRows.filter((s) => s.status === 'overdue');
    const unitRows = units.data || [];
    const taskRows = tasks.data || [];
    const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

    res.json({
      collected_this_month: sum(payments.data || [], 'amount'),
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
      latest_brief: brief.data || null,
    });
  } catch (e) { next(e); }
});

// At-risk customers: 2+ overdue installments, biggest exposure first.
// This is the list a sales manager actually works through in the morning.
router.get('/at-risk', async (req, res, next) => {
  try {
    const today = lagosToday();

    // Scoped by the schedule row's own organization_id rather than through the
    // join path — the column is denormalized so org filtering never depends on
    // a nested filter expression remaining correct.
    const { data, error } = await supabaseAdmin
      .from('re_installment_schedule')
      .select(`
        id, amount_due, due_date,
        re_installment_plans!inner(
          re_reservations!inner(
            id,
            re_customers(id, full_name, phone, email),
            re_units(unit_number, re_projects(name))
          )
        )`)
      .eq('organization_id', req.orgId)
      .eq('status', 'overdue');
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
        overdue_count: 0,
        overdue_amount: 0,
        oldest_due: row.due_date,
      };

      entry.overdue_count += 1;
      entry.overdue_amount += Number(row.amount_due);
      if (row.due_date < entry.oldest_due) entry.oldest_due = row.due_date;
      byCustomer.set(customer.id, entry);
    }

    const atRisk = [...byCustomer.values()]
      .filter((c) => c.overdue_count >= 2)
      .map((c) => ({
        ...c,
        days_late: Math.max(0, Math.round((Date.parse(today) - Date.parse(c.oldest_due)) / 86_400_000)),
      }))
      .sort((a, b) => b.overdue_amount - a.overdue_amount);

    res.json(atRisk);
  } catch (e) { next(e); }
});

module.exports = router;
