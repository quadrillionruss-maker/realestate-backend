// investorReportService.js — the investor/partner summary's data, extracted
// from routes/reports.js's GET /investor (SECTION 11) so financeAgent.js's
// monthly PDF can reuse the EXACT same figures a developer already sees on
// screen, rather than a second computation that could quietly drift from
// it. The route itself now just calls getInvestorReport and forwards the
// result — nothing about what a developer sees changed.
const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday } = require('./overdueService');

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

const firstPlan = (reservation) =>
  Array.isArray(reservation.re_installment_plans)
    ? reservation.re_installment_plans[0]
    : reservation.re_installment_plans;

const emptyTotals = () => ({
  units_total: 0, units_sold: 0, units_reserved: 0, units_available: 0,
  gross_development_value: 0, contracted_value: 0, collected_total: 0,
  collected_this_month: 0, receivables_outstanding: 0, receivables_overdue: 0,
});

// projectId is optional — omit it for the whole org's book, same as before.
async function getInvestorReport(orgId, projectId = null) {
  const today = lagosToday();

  let projectQuery = supabaseAdmin
    .from('re_projects')
    .select('id, name, location, status, total_units, created_at')
    .eq('organization_id', orgId);
  if (projectId) projectQuery = projectQuery.eq('id', projectId);

  const { data: projects, error: projectErr } = await projectQuery;
  if (projectErr) throw projectErr;
  if (projectId && !projects?.length) return { notFound: true };

  const projectIds = (projects || []).map((p) => p.id);
  if (!projectIds.length) {
    return { generated_at: new Date().toISOString(), scope: 'all', projects: [], totals: emptyTotals() };
  }

  const { data: units, error: unitErr } = await supabaseAdmin
    .from('re_units')
    .select('id, project_id, status, list_price')
    .eq('organization_id', orgId)
    .in('project_id', projectIds);
  if (unitErr) throw unitErr;

  const { data: reservations, error: resErr } = await supabaseAdmin
    .from('re_reservations')
    .select(`
      id, status, unit_id, created_at,
      re_units!inner(project_id, list_price),
      re_installment_plans(
        total_amount,
        re_installment_schedule(amount_due, due_date, status)
      )`)
    .eq('organization_id', orgId)
    .in('re_units.project_id', projectIds);
  if (resErr) throw resErr;

  const { data: payments, error: payErr } = await supabaseAdmin
    .from('re_payments')
    .select('amount, paid_at, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(re_units!inner(project_id))))')
    .eq('organization_id', orgId)
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
      collection_rate: contracted > 0 ? Math.round((collected / contracted) * 100) : 0,
      sell_through_rate: projectUnits.length
        ? Math.round(((projectUnits.length - projectUnits.filter((u) => u.status === 'available').length) / projectUnits.length) * 100)
        : 0,
    };
  });

  return {
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
  };
}

module.exports = { getInvestorReport };
