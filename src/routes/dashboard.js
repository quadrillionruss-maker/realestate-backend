const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission, isOwnRecordsOnly, salesRepIdsFor, MATCHES_NOTHING } = require('../middleware/rbac');
const { lagosToday } = require('../services/overdueService');
const { describeStage, isAtRisk } = require('../services/escalationService');
const { canAccess } = require('../services/permissions');
const projectHealth = require('../services/projectHealthService');
const onboarding = require('../services/onboardingService');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Documentation's dashboard answers one question — what still needs doing on
// paper — and none of the financial ones the other roles' KPIs are built
// from, so it is its own small query rather than a stripped-down copy of the
// full one below.
async function documentationDashboard(req) {
  const { data, error } = await supabaseAdmin
    .from('re_documents')
    .select('doc_type, status')
    .eq('organization_id', req.orgId);
  if (error) throw error;

  const rows = data || [];
  const count = (pred) => rows.filter(pred).length;

  return {
    role: 'documentation',
    pending_letters: count((r) => r.doc_type === 'allocation_letter' && r.status === 'pending'),
    unsigned_deeds: count((r) => r.doc_type === 'deed_of_assignment' && r.status !== 'signed'),
    by_status: {
      pending: count((r) => r.status === 'pending'),
      generated: count((r) => r.status === 'generated'),
      sent: count((r) => r.status === 'sent'),
      signed: count((r) => r.status === 'signed'),
    },
  };
}

// One endpoint, one fetch, the whole dashboard. The CEO screen is the product's
// daily habit — it should never be five spinners.
//
// `?project_id=` scopes everything below to a single development. A developer
// running Lekki Gardens, Abuja Hills and Port Harcourt Terrace sees one
// combined "collected this month" without it, and cannot tell which of the
// three has the problem — which is the only thing they wanted to know when
// they opened the page.
//
// CONTENT, NOT THE ROUTE, IS WHAT CHANGES BY ROLE — every authenticated role
// may open this endpoint (requirePermission('dashboard.read') is ALL), and
// what comes back is what the role definitions actually describe: Owner and
// Sales Director get the full executive picture; Collections gets the
// overdue-focused numbers and no brief; a Sales Executive gets those same
// numbers narrowed to their own book; Documentation gets none of it and a
// document-status summary instead (see documentationDashboard above).
router.get('/', requirePermission('dashboard.read'), async (req, res, next) => {
  try {
    if (req.orgRole === 'documentation') {
      return res.json(await documentationDashboard(req));
    }

    const orgId = req.orgId;
    const projectId = req.query.project_id || null;
    if (projectId && !UUID_RE.test(projectId)) {
      return res.status(400).json({ error: 'project_id must be a valid id.' });
    }
    const today = lagosToday();
    const monthStart = today.slice(0, 8) + '01';
    const in7 = new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10);
    const ownOnly = isOwnRecordsOnly(req.orgRole);
    const repIds = ownOnly ? await salesRepIdsFor(req) : null;

    // Scoping money to a project, and splitting it into sales vs rental
    // income, both mean walking payment → schedule → plan → reservation →
    // unit → project. That join used to be built only when a project was
    // actually selected; property_type now needs it every time, so the
    // unscoped path pays that one join cost unconditionally.
    let paymentsQuery = supabaseAdmin.from('re_payments')
      .select('amount, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(property_type, sales_rep_id, re_units!inner(project_id))))')
      .eq('organization_id', orgId)
      .gte('paid_at', monthStart)
      .is('voided_at', null);

    let scheduleQuery = supabaseAdmin.from('re_installment_schedule')
      .select((projectId || ownOnly)
        ? 'amount_due, due_date, status, re_installment_plans!inner(re_reservations!inner(sales_rep_id, re_units!inner(project_id)))'
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

    // A Sales Executive's dashboard is their own book, not the company's —
    // same sales_rep_id join every other own-records filter in this product
    // uses, applied at the query level rather than filtered out in JS.
    if (ownOnly) {
      const ids = repIds.length ? repIds : [MATCHES_NOTHING];
      paymentsQuery = paymentsQuery.in(
        're_installment_schedule.re_installment_plans.re_reservations.sales_rep_id', ids);
      scheduleQuery = scheduleQuery.in(
        're_installment_plans.re_reservations.sales_rep_id', ids);
    }

    const [payments, schedule, units, tasks, brief, projects] = await Promise.all([
      paymentsQuery,
      scheduleQuery,
      unitsQuery,
      supabaseAdmin.from('re_tasks')
        .select('id, source').eq('organization_id', orgId).eq('status', 'open'),
      // The brief is Owner/Sales Director only — Collections and a Sales
      // Executive get no strategic brief at all (their own narrower reasons
      // are handled below), so there is nothing to fetch for them.
      (req.orgRole === 'owner' || req.orgRole === 'sales_director')
        ? supabaseAdmin.from('re_ai_briefs')
            .select('summary, payload, brief_date, generated_by').eq('organization_id', orgId)
            .order('brief_date', { ascending: false }).limit(1).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      // The project list travels with the dashboard so the filter control has
      // something to render without a second request on first paint.
      supabaseAdmin.from('re_projects')
        .select('id, name, location, status').eq('organization_id', orgId).order('name'),
    ]);

    for (const result of [payments, schedule, units, tasks, brief, projects]) {
      if (result.error) throw result.error;
    }

    // SECTION 15 — the "health score below 40" warning card, owner only.
    // Not part of the Promise.all above: it is its own multi-query read
    // (projectHealthService.criticalProjects), not a single supabaseAdmin
    // call the generic error-check loop just above could validate the
    // same way.
    const criticalProjects = canAccess(req.orgRole, 'projectHealth.read')
      ? await projectHealth.criticalProjects(orgId).catch((err) => {
          console.warn('[dashboard] could not load critical projects:', err.message);
          return [];
        })
      : [];

    const scheduleRows = schedule.data || [];
    const overdueRows = scheduleRows.filter((s) => s.status === 'overdue');
    const unitRows = units.data || [];
    const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

    // A Sales Executive's tasks are their own — same test tasks.js's own list
    // applies: assigned to them directly, or tied to one of their reservations.
    let taskRows = tasks.data || [];
    if (ownOnly) {
      let ownReservationIds = [];
      if (repIds.length) {
        const { data: owned } = await supabaseAdmin
          .from('re_reservations').select('id')
          .eq('organization_id', orgId).in('sales_rep_id', repIds);
        ownReservationIds = (owned || []).map((r) => r.id);
      }
      const { data: mine } = await supabaseAdmin
        .from('re_tasks').select('id, source')
        .eq('organization_id', orgId).eq('status', 'open')
        .or([
          `assigned_to.eq.${req.userId}`,
          ownReservationIds.length ? `related_reservation_id.in.(${ownReservationIds.join(',')})` : null,
        ].filter(Boolean).join(','));
      taskRows = mine || [];
    }

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
      // null outright for anyone but Owner/Sales Director — see the query
      // above, which never fetches one for them.
      latest_brief: brief.data || null,
      // SECTION 15 — [] for anyone but the owner (see the query above,
      // which never fetches this for anyone else either).
      critical_projects: criticalProjects,
    });
  } catch (e) { next(e); }
});

// At-risk customers: any overdue installment at all, worst first — see
// escalationService.isAtRisk for why the threshold is 1, not 2.
// This is the list a sales manager actually works through in the morning.
// Owner, Sales Director and Collections only — a Sales Executive sees their
// own buyers' status on the buyer screen instead, and Documentation has no
// reason to see arrears at all.
router.get('/at-risk', requirePermission('atRisk.read'), async (req, res, next) => {
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
      if (!UUID_RE.test(req.query.project_id)) {
        return res.status(400).json({ error: 'project_id must be a valid id.' });
      }
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

    const atRisk = [...byCustomer.values()].filter((c) => isAtRisk(c.overdue_count));

    // Promises turn "two months behind" into "two months behind AND broke a
    // promise on the 15th" — a different conversation, and it belongs on the
    // same card rather than on a screen nobody opens.
    const scheduleIds = atRisk.flatMap((c) => c.schedule_ids);
    const promiseBySchedule = new Map();
    if (scheduleIds.length) {
      const { data: promises } = await supabaseAdmin
        .from('re_payment_promises')
        .select('id, schedule_id, promised_date, promised_amount, status, spoke_to')
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

// SECTION 23 — the workspace's own setup checklist, same permission gate as
// the main dashboard: every role that may see the dashboard may see how
// finished the workspace's own setup is.
router.get('/onboarding', requirePermission('dashboard.read'), async (req, res, next) => {
  try {
    res.json(await onboarding.checklist(req.orgId));
  } catch (e) { next(e); }
});

module.exports = router;
