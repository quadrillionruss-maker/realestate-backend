// routes/reports.js — the numbers someone outside the building asks for.
//
// Most Nigerian developments are funded partly by external investors who put in
// ₦50–100m and are not involved day to day. They do not want a login; they want
// a page once a month saying how many units sold, how much came in, and when
// they get their money back. Today that page is built by hand in PowerPoint
// from the same data this API already has.
//
// Everything here is READ-ONLY and derived. No report writes anything, so a
// figure in a report can always be traced back to the rows that produced it.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const { lagosToday } = require('../services/overdueService');
const { toCsv } = require('../utils/csv');
const { audit } = require('../services/auditService');
const router = express.Router();

// A compromised low-privilege account (see CLAUDE.md's RBAC notes) could
// otherwise use the generic global limiter's 600/15min budget for fast,
// hard-to-throttle data exfiltration — the whole buyer list and payment
// history, repeatedly. Keyed per user, not per IP.
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  message: { error: 'Too many exports. Wait a few minutes and try again.' },
});

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Investor / partner summary. Optionally scoped to one project, because an
// investor almost always backed ONE development and has no business seeing
// the developer's whole book.
router.get('/investor', requirePermission('reports.investor'), async (req, res, next) => {
  try {
    const projectId = req.query.project_id || null;
    // Validated up front rather than left to reach Postgres unshaped — a
    // malformed uuid against a uuid column surfaces as an opaque 500 instead
    // of a clear 400.
    if (projectId && !UUID_RE.test(projectId)) {
      return res.status(400).json({ error: 'project_id must be a valid id.' });
    }
    const today = lagosToday();

    let projectQuery = supabaseAdmin
      .from('re_projects')
      .select('id, name, location, status, total_units, created_at')
      .eq('organization_id', req.orgId);
    if (projectId) projectQuery = projectQuery.eq('id', projectId);

    const { data: projects, error: projectErr } = await projectQuery;
    if (projectErr) throw projectErr;
    if (projectId && !projects?.length) return res.status(404).json({ error: 'Project not found' });

    const projectIds = (projects || []).map((p) => p.id);
    if (!projectIds.length) {
      return res.json({ generated_at: new Date().toISOString(), scope: 'all', projects: [], totals: emptyTotals() });
    }

    const { data: units, error: unitErr } = await supabaseAdmin
      .from('re_units')
      .select('id, project_id, status, list_price')
      .eq('organization_id', req.orgId)
      .in('project_id', projectIds);
    if (unitErr) throw unitErr;

    // Reservation → plan → schedule → payments, in one read. Everything the
    // report needs about money hangs off the schedule row.
    const { data: reservations, error: resErr } = await supabaseAdmin
      .from('re_reservations')
      .select(`
        id, status, unit_id, created_at,
        re_units!inner(project_id, list_price),
        re_installment_plans(
          total_amount,
          re_installment_schedule(amount_due, due_date, status)
        )`)
      .eq('organization_id', req.orgId)
      .in('re_units.project_id', projectIds);
    if (resErr) throw resErr;

    // Filtered by project_id at the DB level, not just in the JS grouping
    // below — an investor report scoped to one development (the common case:
    // "an investor almost always backed ONE development") used to still pull
    // every payment the whole organization has ever recorded, then discard
    // everything outside the requested project after the fact.
    const { data: payments, error: payErr } = await supabaseAdmin
      .from('re_payments')
      .select('amount, paid_at, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(re_units!inner(project_id))))')
      .eq('organization_id', req.orgId)
      .in('re_installment_schedule.re_installment_plans.re_reservations.re_units.project_id', projectIds)
      .is('voided_at', null);
    if (payErr) throw payErr;

    const paymentsByProject = new Map();
    for (const payment of payments || []) {
      const pid = payment.re_installment_schedule?.re_installment_plans
        ?.re_reservations?.re_units?.project_id;
      if (!pid || !projectIds.includes(pid)) continue;
      const list = paymentsByProject.get(pid) || [];
      list.push(payment);
      paymentsByProject.set(pid, list);
    }

    const monthStart = today.slice(0, 8) + '01';

    const rows = (projects || []).map((project) => {
      const projectUnits = (units || []).filter((u) => u.project_id === project.id);
      const projectReservations = (reservations || [])
        .filter((r) => r.re_units?.project_id === project.id);
      const projectPayments = paymentsByProject.get(project.id) || [];

      const contracted = projectReservations
        .filter((r) => r.status !== 'cancelled')
        .reduce((total, r) => {
          const plan = firstPlan(r);
          return total + Number(plan?.total_amount || r.re_units?.list_price || 0);
        }, 0);

      let overdueAmount = 0;
      let scheduledRemaining = 0;
      for (const reservation of projectReservations) {
        if (reservation.status === 'cancelled') continue;
        for (const row of firstPlan(reservation)?.re_installment_schedule || []) {
          if (row.status === 'overdue') overdueAmount += Number(row.amount_due || 0);
          if (row.status === 'pending' || row.status === 'overdue') {
            scheduledRemaining += Number(row.amount_due || 0);
          }
        }
      }

      const collected = sum(projectPayments, 'amount');
      const inventoryValue = sum(projectUnits, 'list_price');

      return {
        project_id: project.id,
        name: project.name,
        location: project.location,
        status: project.status,
        units: {
          total: projectUnits.length || project.total_units || 0,
          sold: projectUnits.filter((u) => u.status === 'sold').length,
          reserved: projectUnits.filter((u) => u.status === 'reserved').length,
          available: projectUnits.filter((u) => u.status === 'available').length,
        },
        gross_development_value: round2(inventoryValue),
        contracted_value: round2(contracted),
        collected_total: round2(collected),
        collected_this_month: round2(
          sum(projectPayments.filter((p) => (p.paid_at || '').slice(0, 10) >= monthStart), 'amount')
        ),
        receivables_outstanding: round2(scheduledRemaining),
        receivables_overdue: round2(overdueAmount),
        // Against what has actually been contracted, not against the whole
        // development — a project that is 20% sold is not 80% behind.
        collection_rate: contracted > 0 ? Math.round((collected / contracted) * 100) : 0,
        sell_through_rate: projectUnits.length
          ? Math.round(((projectUnits.length - projectUnits.filter((u) => u.status === 'available').length) / projectUnits.length) * 100)
          : 0,
      };
    });

    res.json({
      generated_at: new Date().toISOString(),
      period_end: today,
      scope: projectId ? 'project' : 'all',
      projects: rows,
      totals: rows.reduce((totals, row) => ({
        units_total: totals.units_total + row.units.total,
        units_sold: totals.units_sold + row.units.sold,
        units_reserved: totals.units_reserved + row.units.reserved,
        units_available: totals.units_available + row.units.available,
        gross_development_value: round2(totals.gross_development_value + row.gross_development_value),
        contracted_value: round2(totals.contracted_value + row.contracted_value),
        collected_total: round2(totals.collected_total + row.collected_total),
        collected_this_month: round2(totals.collected_this_month + row.collected_this_month),
        receivables_outstanding: round2(totals.receivables_outstanding + row.receivables_outstanding),
        receivables_overdue: round2(totals.receivables_overdue + row.receivables_overdue),
      }), emptyTotals()),
    });
  } catch (e) { next(e); }
});

// Rental portfolio summary. A developer running both a sales book and a
// rental portfolio needs this as its own page — "how full is the building"
// and "how much sold" are different questions with different answers, and
// folding rental units into the sales occupancy numbers above would answer
// neither one correctly.
router.get('/rental', requirePermission('reports.rental'), async (req, res, next) => {
  try {
    const today = lagosToday();
    const monthStart = today.slice(0, 8) + '01';
    const horizon90 = new Date(Date.parse(today) + 90 * 86_400_000).toISOString().slice(0, 10);

    const [units, rentals, rentalPayments, upcoming] = await Promise.all([
      supabaseAdmin.from('re_units')
        .select('status').eq('organization_id', req.orgId),

      // Every LIVE rental reservation, with its current plan's monthly rent
      // (total_amount / number_of_installments — the same arithmetic a
      // rental's schedule was built from in the first place).
      supabaseAdmin.from('re_reservations')
        .select(`
          id, tenancy_start_date, tenancy_end_date,
          re_customers(full_name),
          re_units(unit_number, re_projects(name)),
          re_installment_plans(status, total_amount, number_of_installments)`)
        .eq('organization_id', req.orgId)
        .eq('property_type', 'rental')
        .in('status', ['reserved', 'confirmed']),

      // Rental income specifically, this month — the number this report
      // exists to answer, distinct from the sales collection figures above.
      supabaseAdmin.from('re_payments')
        .select('amount, paid_at, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(property_type)))')
        .eq('organization_id', req.orgId)
        .eq('re_installment_schedule.re_installment_plans.re_reservations.property_type', 'rental')
        .gte('paid_at', monthStart)
        .is('voided_at', null),

      // Renewals due in the next 90 days — the same fact
      // rentalService.checkTenancyRenewals() flags as a task at the 60-day
      // mark, shown here as a forward-looking list rather than a to-do.
      supabaseAdmin.from('re_reservations')
        .select(`
          id, tenancy_end_date,
          re_customers(full_name),
          re_units(unit_number, re_projects(name)),
          re_installment_plans(status, total_amount, number_of_installments)`)
        .eq('organization_id', req.orgId)
        .eq('property_type', 'rental')
        .in('status', ['reserved', 'confirmed'])
        .not('tenancy_end_date', 'is', null)
        .lte('tenancy_end_date', horizon90)
        .order('tenancy_end_date'),
    ]);

    for (const result of [units, rentals, rentalPayments, upcoming]) {
      if (result.error) throw result.error;
    }

    const unitRows = units.data || [];
    const occupied = (rentals.data || []).length;
    const vacant = unitRows.filter((u) => u.status === 'available').length;

    // A renewed tenancy carries BOTH its active and superseded plans in this
    // array (migrations/005) — the superseded one is history, and picking
    // whichever happens to come back first would report last year's rent
    // half the time.
    const monthlyRentOf = (reservation) => {
      const plans = Array.isArray(reservation.re_installment_plans)
        ? reservation.re_installment_plans
        : [reservation.re_installment_plans].filter(Boolean);
      const plan = plans.find((p) => p.status !== 'superseded') || plans[0];
      return plan && plan.number_of_installments
        ? Number(plan.total_amount) / Number(plan.number_of_installments)
        : 0;
    };

    const describeRenewal = (r) => ({
      reservation_id: r.id,
      tenant_name: r.re_customers?.full_name || null,
      unit_number: r.re_units?.unit_number || null,
      project_name: r.re_units?.re_projects?.name || null,
      tenancy_end_date: r.tenancy_end_date,
      current_monthly_rent: round2(monthlyRentOf(r)),
      days_remaining: Math.max(0, Math.round((Date.parse(r.tenancy_end_date) - Date.parse(today)) / 86_400_000)),
    });

    res.json({
      generated_at: new Date().toISOString(),
      period_end: today,
      occupancy: {
        occupied,
        vacant,
        // Against the currently-vacant pool, not the whole unit count — a
        // unit mid-sale-process is neither occupied nor vacant for a rental
        // portfolio's purposes.
        rate: (occupied + vacant) > 0 ? Math.round((occupied / (occupied + vacant)) * 100) : 0,
      },
      monthly_rental_income: round2(sum(rentalPayments.data || [], 'amount')),
      current_monthly_rent_roll: round2(
        (rentals.data || []).reduce((total, r) => total + monthlyRentOf(r), 0)
      ),
      upcoming_renewals: (upcoming.data || []).map(describeRenewal),
    });
  } catch (e) { next(e); }
});

// Month-by-month collections, for the chart on the reports screen and the
// "are we speeding up or slowing down" question underneath it.
router.get('/collections', requirePermission('reports.collections'), async (req, res, next) => {
  try {
    const months = Math.max(1, Math.min(Number(req.query.months) || 12, 36));
    const since = new Date();
    // Clamp to the 1st BEFORE subtracting months, not after. setUTCMonth
    // overflows silently when the current day-of-month doesn't exist in the
    // target month (e.g. today the 31st, target month has 30 days) — it
    // rolls into the following month instead, shifting the whole range (and
    // every bucket built from it below) one month late, which both drops the
    // oldest real month from the query and adds a bogus not-yet-happened one
    // at the end. Every month has a 1st, so subtracting from a date already
    // pinned there can never overflow.
    since.setUTCDate(1);
    since.setUTCMonth(since.getUTCMonth() - (months - 1));

    const { data, error } = await supabaseAdmin
      .from('re_payments')
      .select('amount, paid_at, method')
      .eq('organization_id', req.orgId)
      .gte('paid_at', since.toISOString().slice(0, 10))
      .is('voided_at', null)
      .order('paid_at');
    if (error) throw error;

    const buckets = new Map();
    for (let i = 0; i < months; i += 1) {
      const date = new Date(since);
      date.setUTCMonth(since.getUTCMonth() + i);
      buckets.set(date.toISOString().slice(0, 7), { month: date.toISOString().slice(0, 7), amount: 0, count: 0 });
    }

    for (const payment of data || []) {
      const key = String(payment.paid_at || '').slice(0, 7);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.amount = round2(bucket.amount + Number(payment.amount || 0));
      bucket.count += 1;
    }

    res.json([...buckets.values()]);
  } catch (e) { next(e); }
});

// ── Export ─────────────────────────────────────────────────────────────────
// "Can I get my data out?" is a question a developer asks before they trust a
// system with their buyer list, and the honest answer has to be a button rather
// than a support request. It is also the only backup they control: if this
// service or its Supabase project goes away, these three files are their book.
//
// Streamed as a real file download with Content-Disposition, so it lands in the
// Downloads folder and opens in Excel rather than rendering as text in a tab.
const EXPORTS = {
  customers: {
    filename: 'buyers',
    async load(orgId) {
      const { data, error } = await supabaseAdmin
        .from('re_customers')
        .select('full_name, phone, email, source, created_at')
        .eq('organization_id', orgId)
        .order('full_name');
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Full name', 'full_name'],
      ['Phone', 'phone'],
      ['Email', 'email'],
      ['Source', 'source'],
      ['Added', (r) => String(r.created_at || '').slice(0, 10)],
    ],
  },

  payments: {
    filename: 'payments',
    async load(orgId) {
      const { data, error } = await supabaseAdmin
        .from('re_payments')
        .select(`
          amount, method, paystack_reference, paid_at, overpayment,
          re_installment_schedule(
            installment_number, due_date, amount_due,
            re_installment_plans(
              number_of_installments,
              re_reservations(
                re_customers(full_name, phone),
                re_units(unit_number, re_projects(name))
              )
            )
          )`)
        .eq('organization_id', orgId)
        .order('paid_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Date paid', (r) => String(r.paid_at || '').slice(0, 10)],
      ['Buyer', (r) => reservationOf(r)?.re_customers?.full_name || ''],
      ['Phone', (r) => reservationOf(r)?.re_customers?.phone || ''],
      ['Project', (r) => reservationOf(r)?.re_units?.re_projects?.name || ''],
      ['Unit', (r) => reservationOf(r)?.re_units?.unit_number || ''],
      ['Installment', (r) => {
        const s = r.re_installment_schedule;
        return s ? `${s.installment_number} of ${s.re_installment_plans?.number_of_installments || '?'}` : '';
      }],
      ['Due date', (r) => r.re_installment_schedule?.due_date || ''],
      ['Amount due', (r) => r.re_installment_schedule?.amount_due ?? ''],
      ['Amount paid', 'amount'],
      ['Overpayment', (r) => (Number(r.overpayment) > 0 ? r.overpayment : '')],
      ['Method', (r) => String(r.method || '').replace(/_/g, ' ')],
      ['Reference', 'paystack_reference'],
    ],
  },

  schedule: {
    filename: 'payment-schedule',
    async load(orgId) {
      const { data, error } = await supabaseAdmin
        .from('re_installment_schedule')
        .select(`
          installment_number, due_date, amount_due, status, paid_at,
          re_installment_plans!inner(
            total_amount, number_of_installments,
            re_reservations!inner(
              status, escalation_stage,
              re_customers(full_name, phone),
              re_units(unit_number, re_projects(name))
            )
          )`)
        .eq('organization_id', orgId)
        .order('due_date');
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Buyer', (r) => r.re_installment_plans?.re_reservations?.re_customers?.full_name || ''],
      ['Phone', (r) => r.re_installment_plans?.re_reservations?.re_customers?.phone || ''],
      ['Project', (r) => r.re_installment_plans?.re_reservations?.re_units?.re_projects?.name || ''],
      ['Unit', (r) => r.re_installment_plans?.re_reservations?.re_units?.unit_number || ''],
      ['Plan total', (r) => r.re_installment_plans?.total_amount ?? ''],
      ['Installment', (r) => `${r.installment_number} of ${r.re_installment_plans?.number_of_installments || '?'}`],
      ['Due date', 'due_date'],
      ['Amount due', 'amount_due'],
      ['Status', 'status'],
      ['Paid at', (r) => String(r.paid_at || '').slice(0, 10)],
      ['Escalation', (r) => r.re_installment_plans?.re_reservations?.escalation_stage || ''],
    ],
  },
};

const reservationOf = (payment) =>
  payment.re_installment_schedule?.re_installment_plans?.re_reservations;

router.get('/export/:kind', exportLimiter, requirePermission('reports.export'), async (req, res, next) => {
  try {
    const spec = EXPORTS[req.params.kind];
    if (!spec) {
      return res.status(404).json({
        error: `Nothing to export called "${req.params.kind}". Try: ${Object.keys(EXPORTS).join(', ')}`,
      });
    }

    const rows = await spec.load(req.orgId);
    const stamp = new Date().toISOString().slice(0, 10);

    audit(req, {
      action: 'data.exported',
      entityType: 're_org_settings',
      summary: `Exported ${rows.length} ${req.params.kind} rows to CSV`,
      metadata: { kind: req.params.kind, rows: rows.length },
    });

    res
      .type('text/csv; charset=utf-8')
      .attachment(`archta-${spec.filename}-${stamp}.csv`)
      .send(toCsv(spec.columns, rows));
  } catch (e) { next(e); }
});

const firstPlan = (reservation) =>
  Array.isArray(reservation.re_installment_plans)
    ? reservation.re_installment_plans[0]
    : reservation.re_installment_plans;

const emptyTotals = () => ({
  units_total: 0, units_sold: 0, units_reserved: 0, units_available: 0,
  gross_development_value: 0, contracted_value: 0, collected_total: 0,
  collected_this_month: 0, receivables_outstanding: 0, receivables_overdue: 0,
});

module.exports = router;
