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
const { requirePermission, assertPermission } = require('../middleware/rbac');
const { lagosToday } = require('../services/overdueService');
const { toCsv } = require('../utils/csv');
const { audit } = require('../services/auditService');
const referrals = require('../services/referralService');
const forecast = require('../services/forecastService');
const { getInvestorReport } = require('../services/investorReportService');
const commissionService = require('../services/commissionService');
const satisfactionSurvey = require('../services/satisfactionSurveyService');
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
// Investor / partner summary. Optionally scoped to one project, because an
// investor almost always backed ONE development and has no business seeing
// the developer's whole book.
//
// SECTION 11 — the data-gathering itself now lives in
// investorReportService.getInvestorReport, extracted so financeAgent.js's
// monthly PDF reuses the EXACT same figures this route has always returned,
// rather than a second computation that could quietly drift from it. This
// route's own behaviour (validation, 404, response shape) is unchanged.
router.get('/investor', requirePermission('reports.investor'), async (req, res, next) => {
  try {
    const projectId = req.query.project_id || null;
    // Validated up front rather than left to reach Postgres unshaped — a
    // malformed uuid against a uuid column surfaces as an opaque 500 instead
    // of a clear 400.
    if (projectId && !UUID_RE.test(projectId)) {
      return res.status(400).json({ error: 'project_id must be a valid id.' });
    }

    const report = await getInvestorReport(req.orgId, projectId);
    if (report.notFound) return res.status(404).json({ error: 'Project not found' });
    res.json(report);
  } catch (e) { next(e); }
});

// SECTION 5 — referral network totals: how many referrals were ever opened,
// what share converted (the referred buyer made a first payment), and how
// much of the "credit" reward type has actually been given out. Cash-bonus
// totals are deliberately not summed here — cash is paid manually outside
// this product (the task referralService.fileCashBonusTask files is the
// only record of it), so a total would double as a claim about real money
// this system never actually watched move.
router.get('/referrals', requirePermission('reports.referrals'), async (req, res, next) => {
  try {
    res.json(await referrals.getStats(req.orgId));
  } catch (e) { next(e); }
});

// SECTION 6 — AI sales forecast: projected 3-month collections, a projected
// completion date per active project, up to 5 buyers most likely to default
// in the next 60 days, and recommended actions. Cached 24h
// (forecastService.getOrGenerateForecast) — ?regenerate=true (the Reports
// screen's Regenerate button) forces a fresh model call regardless of age.
router.get('/forecast', requirePermission('reports.forecast'), async (req, res, next) => {
  try {
    const result = await forecast.getOrGenerateForecast(req.orgId, { force: req.query.regenerate === 'true' });
    res.json(result);
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

// A rep's row is scoped to reservations they created inside the chosen
// window — "this month/last 3 months/this year/all time" reads as a date on
// created_at, not a date on any payment, so the same reservation cannot
// appear in two different periods. No reusable date-range helper exists
// elsewhere in this codebase (every other report uses either ?months=N or
// raw ?from=&to=), so this is the first of its kind — kept pure and exported
// below so it is assertable offline.
function periodRange(period, today) {
  if (period === 'this_month') {
    return { from: `${today.slice(0, 7)}-01`, to: null };
  }
  if (period === 'last_3_months') {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 2); // this month plus 2 back = a 3-month window
    return { from: d.toISOString().slice(0, 10), to: null };
  }
  if (period === 'this_year') {
    return { from: `${today.slice(0, 4)}-01-01`, to: null };
  }
  return { from: null, to: null }; // all_time, and the default for anything unrecognised
}

const LEADERBOARD_PERIODS = ['this_month', 'last_3_months', 'this_year', 'all_time'];

// Sales rep leaderboard.
router.get('/leaderboard', requirePermission('reports.leaderboard'), async (req, res, next) => {
  try {
    const period = LEADERBOARD_PERIODS.includes(req.query.period) ? req.query.period : 'all_time';
    const { from, to } = periodRange(period, lagosToday());
    const rows = await commissionService.leaderboard(req.orgId, { from, to });
    res.json({ period, rows });
  } catch (e) { next(e); }
});

// SECTION 18 — buyer satisfaction survey averages + recent comments.
router.get('/satisfaction', requirePermission('reports.satisfaction'), async (req, res, next) => {
  try {
    res.json(await satisfactionSurvey.summary(req.orgId));
  } catch (e) { next(e); }
});

// ── Custom report builder ───────────────────────────────────────────────────
// One row per non-cancelled reservation, since half the available fields
// (unit, project, reservation date, sales rep) are reservation-level, not
// buyer-level — a buyer with two live reservations legitimately appears
// twice, once per unit they hold, the same way EXPORTS.schedule above does.
//
// Kept as a plain object of [label, accessor] pairs, same shape toCsv's
// `columns` argument already expects everywhere else in this file, so a
// field chosen by the caller maps straight onto a CSV column with no
// translation step in between.
function scheduleFigures(reservation) {
  const plans = Array.isArray(reservation.re_installment_plans)
    ? reservation.re_installment_plans
    : [reservation.re_installment_plans].filter(Boolean);
  const plan = plans.find((p) => p.status === 'active') || plans[0];
  const contracted = Number(plan?.total_amount || reservation.re_units?.list_price || 0);

  let paid = 0;
  let overdue = 0;
  let lastPaymentDate = null;
  let nextDueDate = null;
  for (const row of plan?.re_installment_schedule || []) {
    if (row.status === 'paid') {
      paid += Number(row.amount_due || 0);
      const paidDate = String(row.paid_at || '').slice(0, 10);
      if (paidDate && (!lastPaymentDate || paidDate > lastPaymentDate)) lastPaymentDate = paidDate;
    } else if (row.status === 'overdue') {
      overdue += Number(row.amount_due || 0);
    }
    if ((row.status === 'pending' || row.status === 'overdue')
      && (!nextDueDate || row.due_date < nextDueDate)) {
      nextDueDate = row.due_date;
    }
  }

  return {
    contracted: round2(contracted),
    paid: round2(paid),
    balance: round2(Math.max(0, contracted - paid)),
    overdue: round2(overdue),
    lastPaymentDate,
    nextDueDate,
  };
}

const CUSTOM_REPORT_FIELDS = {
  buyer_name: ['Buyer name', (r) => r.re_customers?.full_name || ''],
  email: ['Email', (r) => r.re_customers?.email || ''],
  phone: ['Phone', (r) => r.re_customers?.phone || ''],
  unit_number: ['Unit number', (r) => r.re_units?.unit_number || ''],
  project_name: ['Project name', (r) => r.re_units?.re_projects?.name || ''],
  total_contracted: ['Total contracted', (r) => r.__figures.contracted],
  total_paid: ['Total paid', (r) => r.__figures.paid],
  balance: ['Balance', (r) => r.__figures.balance],
  overdue_amount: ['Overdue amount', (r) => r.__figures.overdue],
  credit_score: ['Credit score', (r) => r.re_customers?.credit_score ?? ''],
  sales_rep_name: ['Sales rep name', (r) => r.re_sales_reps?.users?.full_name || ''],
  reservation_date: ['Reservation date', (r) => String(r.reserved_at || '').slice(0, 10)],
  last_payment_date: ['Last payment date', (r) => r.__figures.lastPaymentDate || ''],
  next_due_date: ['Next due date', (r) => r.__figures.nextDueDate || ''],
  escalation_stage: ['Escalation stage', (r) => r.escalation_stage || 'none'],
  referral_code: ['Referral code', (r) => r.re_customers?.referral_code || ''],
};

// Pure — which of the requested field ids are real, in the order given (a
// caller re-ordering their checkbox list re-orders the CSV, rather than the
// registry's own key order winning silently). Exported so the "at least one
// valid field" rule is assertable offline.
function buildCustomReportColumns(fieldsParam) {
  const requested = String(fieldsParam || '').split(',').map((f) => f.trim()).filter(Boolean);
  return requested.filter((f) => CUSTOM_REPORT_FIELDS[f]).map((f) => CUSTOM_REPORT_FIELDS[f]);
}

router.get('/custom-export', exportLimiter, requirePermission('reports.customExport'), async (req, res, next) => {
  try {
    const columns = buildCustomReportColumns(req.query.fields);
    if (!columns.length) {
      return res.status(400).json({
        error: 'No valid fields given. Choose at least one of: ' + Object.keys(CUSTOM_REPORT_FIELDS).join(', '),
      });
    }

    const { data, error } = await supabaseAdmin
      .from('re_reservations')
      .select(`
        reserved_at, escalation_stage,
        re_customers(full_name, email, phone, credit_score, referral_code),
        re_units(unit_number, list_price, re_projects(name)),
        re_sales_reps(users(full_name)),
        re_installment_plans(
          status, total_amount,
          re_installment_schedule(status, amount_due, due_date, paid_at)
        )`)
      .eq('organization_id', req.orgId)
      .neq('status', 'cancelled')
      .order('reserved_at', { ascending: false });
    if (error) throw error;

    const rows = (data || []).map((r) => ({ ...r, __figures: scheduleFigures(r) }));
    const stamp = new Date().toISOString().slice(0, 10);

    audit(req, {
      action: 'data.exported',
      entityType: 're_org_settings',
      summary: `Exported ${rows.length} row(s) to a custom report (${columns.length} field(s))`,
      metadata: { fields: req.query.fields, rows: rows.length },
    });

    res
      .type('text/csv; charset=utf-8')
      .attachment(`archta-custom-report-${stamp}.csv`)
      .send(toCsv(columns, rows));
  } catch (e) { next(e); }
});

// ── Payment heatmap ──────────────────────────────────────────────────────────
// Which day OF THE MONTH buyers actually pay on, aggregated across every
// month this workspace has ever collected on — not a real calendar (day 15
// falls on a different weekday every month, so there is no single weekday to
// anchor a specific day-of-month bucket to). The frontend lays this out as a
// 7-wide grid in day order for a calendar-like read, without claiming any
// particular day fell on a particular weekday.
function bucketPaymentsByDayOfMonth(payments) {
  const days = Array.from({ length: 31 }, (_, i) => ({ day: i + 1, amount: 0, count: 0 }));
  for (const payment of payments || []) {
    const dayOfMonth = Number(String(payment.paid_at || '').slice(8, 10));
    if (dayOfMonth >= 1 && dayOfMonth <= 31) {
      const bucket = days[dayOfMonth - 1];
      bucket.amount = round2(bucket.amount + Number(payment.amount || 0));
      bucket.count += 1;
    }
  }
  return days;
}

router.get('/payment-heatmap', requirePermission('reports.heatmap'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_payments')
      .select('amount, paid_at')
      .eq('organization_id', req.orgId)
      .is('voided_at', null);
    if (error) throw error;

    const days = bucketPaymentsByDayOfMonth(data);
    res.json({ days, max_amount: days.reduce((max, d) => Math.max(max, d.amount), 0) });
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
    // SECTION 4 — "Export selected" on the Buyers screen's bulk action bar
    // reuses this exact export, scoped with `ids` rather than growing a
    // second, near-identical loader: the columns and the data shape must
    // stay in lockstep with the unfiltered "Export buyers" button, and a
    // second copy is the one that drifts.
    async load(orgId, params = {}) {
      let query = supabaseAdmin
        .from('re_customers')
        .select(`
          full_name, phone, email, source, created_at, credit_score,
          re_reservations(
            status,
            re_units(unit_number, bedrooms, bathrooms, parking_spaces, floor_level, furnishing_status, re_projects(name))
          )`)
        .eq('organization_id', orgId)
        .order('full_name');
      if (params.ids) {
        const ids = String(params.ids).split(',').map((id) => id.trim()).filter(Boolean);
        if (ids.length) query = query.in('id', ids);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Full name', 'full_name'],
      ['Phone', 'phone'],
      ['Email', 'email'],
      ['Source', 'source'],
      ['Added', (r) => String(r.created_at || '').slice(0, 10)],
      // SECTION 3 — 0-100, built entirely from data this export's own
      // sibling files (payments, promises) already contain.
      ['Credit score', (r) => r.credit_score ?? ''],
      // SECTION 6 — the unit behind whichever of this buyer's reservations
      // is not cancelled, falling back to the first one at all so a buyer
      // whose only reservation was cancelled still shows what they once
      // held rather than a blank row.
      ['Project', (r) => primaryUnit(r)?.re_projects?.name || ''],
      ['Unit', (r) => primaryUnit(r)?.unit_number || ''],
      ['Bedrooms', (r) => primaryUnit(r)?.bedrooms ?? ''],
      ['Bathrooms', (r) => primaryUnit(r)?.bathrooms ?? ''],
      ['Parking', (r) => primaryUnit(r)?.parking_spaces ?? ''],
      ['Floor level', (r) => primaryUnit(r)?.floor_level ?? ''],
      ['Furnishing', (r) => primaryUnit(r)?.furnishing_status || ''],
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

  // TASK 3 AUDIT FIX (Important #11) — the six newer feature areas had no
  // export coverage at all: a compliance request for "everything about
  // this workspace" silently missed hardship, legal, financing, handover/
  // snagging, contractor and community data. `permission` on a spec is an
  // ADDITIONAL gate the route below checks beyond reports.export — these
  // six read data whose OWN reading permission (hardship.review, legal.read,
  // etc.) is not uniformly DIRECTORS-level the way reports.export itself is
  // (contractors.manage is OWNER only), so exporting must not grant access
  // wider than the feature's own screen already does.
  hardship: {
    filename: 'hardship-requests',
    permission: 'hardship.review',
    async load(orgId) {
      const { data, error } = await supabaseAdmin
        .from('re_hardship_requests')
        .select(`
          status, pause_months, reason, requested_by_portal, reviewed_at, applied_at, created_at,
          re_customers(full_name, phone),
          re_reservations(re_units(unit_number, re_projects(name)))
        `)
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Buyer', (r) => r.re_customers?.full_name || ''],
      ['Phone', (r) => r.re_customers?.phone || ''],
      ['Project', (r) => r.re_reservations?.re_units?.re_projects?.name || ''],
      ['Unit', (r) => r.re_reservations?.re_units?.unit_number || ''],
      ['Status', 'status'],
      ['Pause (months)', 'pause_months'],
      ['Reason', 'reason'],
      ['Requested from portal', (r) => (r.requested_by_portal ? 'Yes' : 'No')],
      ['Reviewed at', (r) => String(r.reviewed_at || '').slice(0, 10)],
      ['Applied at', (r) => String(r.applied_at || '').slice(0, 10)],
      ['Requested at', (r) => String(r.created_at || '').slice(0, 10)],
    ],
  },

  legal_cases: {
    filename: 'legal-cases',
    permission: 'legal.read',
    async load(orgId) {
      const { data, error } = await supabaseAdmin
        .from('re_legal_cases')
        .select(`
          status, lawyer_name, lawyer_phone, demand_letter_sent_at,
          settlement_amount, settlement_date, notes, created_at,
          re_customers(full_name, phone),
          re_reservations(re_units(unit_number, re_projects(name)))
        `)
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Buyer', (r) => r.re_customers?.full_name || ''],
      ['Phone', (r) => r.re_customers?.phone || ''],
      ['Project', (r) => r.re_reservations?.re_units?.re_projects?.name || ''],
      ['Unit', (r) => r.re_reservations?.re_units?.unit_number || ''],
      ['Status', 'status'],
      ['Lawyer', (r) => r.lawyer_name || ''],
      ['Lawyer phone', (r) => r.lawyer_phone || ''],
      ['Demand letter sent', (r) => String(r.demand_letter_sent_at || '').slice(0, 10)],
      ['Settlement amount', (r) => r.settlement_amount ?? ''],
      ['Settlement date', (r) => r.settlement_date || ''],
      ['Notes', (r) => r.notes || ''],
      ['Opened at', (r) => String(r.created_at || '').slice(0, 10)],
    ],
  },

  financing_requests: {
    filename: 'financing-requests',
    permission: 'financing.read',
    async load(orgId) {
      const { data, error } = await supabaseAdmin
        .from('re_financing_requests')
        .select(`
          bank_name, amount_requested, status, submitted_at, bank_reference, notes, created_at,
          re_customers(full_name, phone),
          re_reservations(re_units(unit_number, re_projects(name)))
        `)
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Buyer', (r) => r.re_customers?.full_name || ''],
      ['Phone', (r) => r.re_customers?.phone || ''],
      ['Project', (r) => r.re_reservations?.re_units?.re_projects?.name || ''],
      ['Unit', (r) => r.re_reservations?.re_units?.unit_number || ''],
      ['Bank', 'bank_name'],
      ['Amount requested', 'amount_requested'],
      ['Status', 'status'],
      ['Bank reference', (r) => r.bank_reference || ''],
      ['Submitted at', (r) => String(r.submitted_at || '').slice(0, 10)],
      ['Notes', (r) => r.notes || ''],
      ['Requested at', (r) => String(r.created_at || '').slice(0, 10)],
    ],
  },

  handover: {
    filename: 'handover-checklists',
    permission: 'handover.manage',
    async load(orgId) {
      const { data, error } = await supabaseAdmin
        .from('re_handover_checklists')
        .select(`
          status, handover_date, keys_handed, created_at,
          re_reservations(re_customers(full_name, phone), re_units(unit_number, re_projects(name))),
          re_snagging_items(status)
        `)
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Buyer', (r) => r.re_reservations?.re_customers?.full_name || ''],
      ['Phone', (r) => r.re_reservations?.re_customers?.phone || ''],
      ['Project', (r) => r.re_reservations?.re_units?.re_projects?.name || ''],
      ['Unit', (r) => r.re_reservations?.re_units?.unit_number || ''],
      ['Status', 'status'],
      ['Handover date', (r) => r.handover_date || ''],
      ['Keys handed', (r) => (r.keys_handed ? 'Yes' : 'No')],
      ['Snagging items', (r) => (r.re_snagging_items || []).length],
      ['Snagging items open', (r) => (r.re_snagging_items || []).filter((s) => s.status === 'open').length],
      ['Created at', (r) => String(r.created_at || '').slice(0, 10)],
    ],
  },

  contractor_payments: {
    filename: 'contractor-payments',
    permission: 'contractors.manage',
    async load(orgId) {
      const { data, error } = await supabaseAdmin
        .from('re_contractor_payments')
        .select(`
          amount, due_date, paid_date, status, description, created_at,
          re_contractors(name, type),
          re_projects(name)
        `)
        .eq('organization_id', orgId)
        .order('due_date', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Contractor', (r) => r.re_contractors?.name || ''],
      ['Trade', (r) => r.re_contractors?.type || ''],
      ['Project', (r) => r.re_projects?.name || ''],
      ['Amount', 'amount'],
      ['Due date', 'due_date'],
      ['Paid date', (r) => r.paid_date || ''],
      ['Status', 'status'],
      ['Description', (r) => r.description || ''],
      ['Created at', (r) => String(r.created_at || '').slice(0, 10)],
    ],
  },

  community: {
    filename: 'community-posts',
    permission: 'community.moderate',
    async load(orgId) {
      const { data, error } = await supabaseAdmin
        .from('re_community_posts')
        .select(`
          content, pinned, moderated, created_at,
          re_customers(full_name),
          re_projects(name),
          re_community_replies(id)
        `)
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    columns: [
      ['Author', (r) => r.re_customers?.full_name || ''],
      ['Project', (r) => r.re_projects?.name || ''],
      ['Content', 'content'],
      ['Pinned', (r) => (r.pinned ? 'Yes' : 'No')],
      ['Moderated', (r) => (r.moderated ? 'Yes' : 'No')],
      ['Replies', (r) => (r.re_community_replies || []).length],
      ['Posted at', (r) => String(r.created_at || '').slice(0, 10)],
    ],
  },
};

const reservationOf = (payment) =>
  payment.re_installment_schedule?.re_installment_plans?.re_reservations;

// SECTION 6 — one unit to show per buyer row on the customers export. A
// buyer with more than one reservation shows their live one; cancelled is
// the fallback, not the default, so a currently-active allocation always
// wins over history.
function primaryUnit(customer) {
  const reservations = Array.isArray(customer.re_reservations)
    ? customer.re_reservations
    : [customer.re_reservations].filter(Boolean);
  const live = reservations.find((r) => r.status !== 'cancelled') || reservations[0];
  return live?.re_units || null;
}

router.get('/export/:kind', exportLimiter, requirePermission('reports.export'), async (req, res, next) => {
  try {
    const spec = EXPORTS[req.params.kind];
    if (!spec) {
      return res.status(404).json({
        error: `Nothing to export called "${req.params.kind}". Try: ${Object.keys(EXPORTS).join(', ')}`,
      });
    }
    // TASK 3 AUDIT FIX (Important #11) — some export kinds read data whose
    // own permission is narrower than reports.export itself (e.g.
    // contractors.manage is owner-only; reports.export is DIRECTORS) —
    // checked here, per kind, rather than only at the router.get gate above,
    // exactly the "depends on the request, not just the path" pattern
    // src/middleware/rbac.js's own comment describes assertPermission for.
    if (spec.permission && !assertPermission(req, res, spec.permission)) return;

    const rows = await spec.load(req.orgId, req.query);
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

module.exports = router;
// Pure helpers, attached to the exported router for the offline test suite —
// same pattern audit.js uses for redactFinancialAuditRows.
module.exports.periodRange = periodRange;
module.exports.buildCustomReportColumns = buildCustomReportColumns;
module.exports.bucketPaymentsByDayOfMonth = bucketPaymentsByDayOfMonth;
module.exports.CUSTOM_REPORT_FIELDS = CUSTOM_REPORT_FIELDS;
