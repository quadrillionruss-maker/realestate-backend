// projectHealthService.js — abandoned project early warning system, SECTION 15.
//
// Five signals, 20 points each, computed once a day (jobs/daily.js) and
// stored as one row per project per day (migrations/038) — never recomputed
// on request, because "below 60 for 3 consecutive days" only means anything
// against a fixed daily snapshot, the same reasoning credit scores or
// escalation stages are computed by a sweep rather than live.
//
// ONE SUBSTITUTION WORTH STATING PLAINLY: "developer login frequency" has no
// dedicated event log in this schema — users.last_login_at (migrations/001)
// is a single timestamp, not a history, so a week-over-week trend cannot be
// built from it. re_audit_log already records every authenticated action
// with actor_id and created_at, for every role, and is the closest
// available proxy for "is the developer team actually engaging with the
// system" without adding a new login-event table this section was not
// asked to add. Signal key stays `developer_engagement`, not
// `login_frequency`, to name what it actually measures.
const { supabaseAdmin } = require('../middleware/orgContext');
const { auditSystem } = require('./auditService');

const WEIGHTS = { milestone_freshness: 20, developer_engagement: 20, collection_trend: 20, rep_activity: 20, buyer_complaints: 20 };
const WARNING_THRESHOLD = 60; // below this for 3 consecutive days files a task
const CRITICAL_THRESHOLD = 40; // below this shows the dashboard warning card
const CONSECUTIVE_DAYS_FOR_TASK = 3;
const CONSECUTIVE_DAYS_FOR_PORTAL_NOTICE = 14;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// Linear interpolation: `value` at or below `badAt` scores 0, at or above
// `goodAt` scores full `points`, straight-line between the two. Used for
// every signal below so "how many points does this number earn" is one
// formula, not five hand-rolled ones.
const scale = (value, badAt, goodAt, points) => {
  if (goodAt === badAt) return value >= goodAt ? points : 0;
  const ratio = (value - badAt) / (goodAt - badAt);
  return Math.round(clamp(ratio, 0, 1) * points);
};

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86_400_000);

// ── Signal 1: construction milestone freshness ────────────────────────
async function milestoneFreshness(orgId, project) {
  const { data: milestones } = await supabaseAdmin
    .from('re_construction_milestones')
    .select('updated_at')
    .eq('organization_id', orgId)
    .eq('project_id', project.id);

  const latest = (milestones || []).reduce((max, m) => (m.updated_at > max ? m.updated_at : max), null);
  // No milestone row yet (never opened — constructionService provisions
  // them lazily) reads from the PROJECT's own age instead — a brand-new
  // project with nothing touched yet is not "abandoned", an old one still
  // untouched is exactly the pattern this signal exists to catch.
  const reference = latest || project.created_at;
  const days = daysBetween(reference, new Date().toISOString());

  return {
    days_since_update: days,
    points: scale(days, 90, 14, WEIGHTS.milestone_freshness),
  };
}

// ── Signal 2: developer engagement (re_audit_log as the available proxy
// for login frequency — see this file's own header) ───────────────────
async function developerEngagement(orgId) {
  const now = new Date();
  var thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  var lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const { data: rows } = await supabaseAdmin
    .from('re_audit_log')
    .select('created_at')
    .eq('organization_id', orgId)
    .eq('actor_kind', 'user')
    .gte('created_at', lastMonthStart.toISOString());

  const thisMonthCount = (rows || []).filter((r) => r.created_at >= thisMonthStart.toISOString()).length;
  const lastMonthCount = (rows || []).filter((r) => r.created_at < thisMonthStart.toISOString()).length;

  const daysElapsedThisMonth = Math.max(1, daysBetween(thisMonthStart.toISOString(), now.toISOString()) + 1);
  const thisMonthWeeklyAvg = (thisMonthCount / daysElapsedThisMonth) * 7;
  const lastMonthWeeklyAvg = (lastMonthCount / 30) * 7;

  // No activity at all last month (a workspace in its first month) has
  // nothing to trend against — read as neutral rather than penalised for a
  // comparison that cannot be made yet.
  if (lastMonthWeeklyAvg === 0) {
    return { this_month_weekly_avg: Math.round(thisMonthWeeklyAvg * 10) / 10, last_month_weekly_avg: 0, trend_ratio: null, points: WEIGHTS.developer_engagement };
  }

  const ratio = thisMonthWeeklyAvg / lastMonthWeeklyAvg;
  return {
    this_month_weekly_avg: Math.round(thisMonthWeeklyAvg * 10) / 10,
    last_month_weekly_avg: Math.round(lastMonthWeeklyAvg * 10) / 10,
    trend_ratio: Math.round(ratio * 100) / 100,
    points: scale(ratio, 0.3, 1, WEIGHTS.developer_engagement),
  };
}

// ── Signal 3: collection rate trend, this project only ─────────────────
async function collectionTrend(orgId, project) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const trailingStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0, 10);

  const { data: payments } = await supabaseAdmin
    .from('re_payments')
    .select('amount, paid_at, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(re_units!inner(project_id))))')
    .eq('organization_id', orgId)
    .eq('re_installment_schedule.re_installment_plans.re_reservations.re_units.project_id', project.id)
    .gte('paid_at', trailingStart)
    .is('voided_at', null);

  const rows = payments || [];
  const thisMonth = rows.filter((p) => p.paid_at >= monthStart).reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const trailing = rows.filter((p) => p.paid_at < monthStart).reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const trailingMonthlyAvg = trailing / 3;

  const daysElapsed = Math.max(1, daysBetween(monthStart, now.toISOString()) + 1);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const projectedThisMonth = (thisMonth / daysElapsed) * daysInMonth;

  if (trailingMonthlyAvg === 0) {
    // Nothing collected in the trailing window either — a project that
    // never had money coming in is either brand new (neutral) or already
    // known-bad by every other signal; this one alone should not swing it.
    return { this_month_projected: Math.round(projectedThisMonth), trailing_3mo_avg: 0, points: WEIGHTS.collection_trend };
  }

  const ratio = projectedThisMonth / trailingMonthlyAvg;
  return {
    this_month_projected: Math.round(projectedThisMonth),
    trailing_3mo_avg: Math.round(trailingMonthlyAvg),
    trend_ratio: Math.round(ratio * 100) / 100,
    points: scale(ratio, 0.3, 1, WEIGHTS.collection_trend),
  };
}

// ── Signal 4: sales rep activity level ──────────────────────────────────
async function repActivityLevel(orgId, project) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [{ data: units }, { data: tasksDone }] = await Promise.all([
    supabaseAdmin.from('re_units').select('id').eq('organization_id', orgId).eq('project_id', project.id),
    supabaseAdmin.from('re_tasks')
      .select('id, related_reservation_id')
      .eq('organization_id', orgId).eq('status', 'done').gte('updated_at', since),
  ]);
  const unitIds = (units || []).map((u) => u.id);

  const { data: reservations } = unitIds.length
    ? await supabaseAdmin.from('re_reservations').select('id, customer_id').eq('organization_id', orgId).in('unit_id', unitIds)
    : { data: [] };
  const reservationIds = (reservations || []).map((r) => r.id);
  const customerIds = [...new Set((reservations || []).map((r) => r.customer_id))];

  const { data: activities } = customerIds.length
    ? await supabaseAdmin.from('re_activities').select('id').eq('organization_id', orgId).in('customer_id', customerIds).gte('created_at', since).is('deleted_at', null)
    : { data: [] };

  const tasksForProject = (tasksDone || []).filter((t) => reservationIds.includes(t.related_reservation_id)).length;
  const total = tasksForProject + (activities || []).length;

  // No natural "expected" baseline per project (unlike the trend signals
  // above, which compare a project against its own recent past) — a flat
  // threshold stands in: 10+ logged touches across a project's buyers in
  // 30 days reads as an actively worked book.
  return { tasks_completed: tasksForProject, activities_logged: (activities || []).length, points: scale(total, 0, 10, WEIGHTS.rep_activity) };
}

// ── Signal 5: buyer complaints / disputes ───────────────────────────────
async function buyerComplaints(orgId, project) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data: units } = await supabaseAdmin.from('re_units').select('id').eq('organization_id', orgId).eq('project_id', project.id);
  const unitIds = (units || []).map((u) => u.id);
  const { data: reservations } = unitIds.length
    ? await supabaseAdmin.from('re_reservations').select('id').eq('organization_id', orgId).in('unit_id', unitIds)
    : { data: [] };
  const reservationIds = (reservations || []).map((r) => r.id);
  if (!reservationIds.length) return { disputed_snags: 0, broken_promises: 0, legal_cases_opened: 0, points: WEIGHTS.buyer_complaints };

  const { data: checklists } = await supabaseAdmin
    .from('re_handover_checklists').select('id').eq('organization_id', orgId).in('reservation_id', reservationIds);
  const checklistIds = (checklists || []).map((c) => c.id);

  const [{ data: disputedSnags }, { data: brokenPromises }, { data: legalCases }] = await Promise.all([
    checklistIds.length
      ? supabaseAdmin.from('re_snagging_items').select('id').in('checklist_id', checklistIds).eq('status', 'disputed')
      : Promise.resolve({ data: [] }),
    supabaseAdmin.from('re_payment_promises')
      .select('id, re_installment_schedule!inner(re_installment_plans!inner(reservation_id))')
      .eq('organization_id', orgId).eq('status', 'broken')
      .in('re_installment_schedule.re_installment_plans.reservation_id', reservationIds)
      .gte('promised_date', since.slice(0, 10)),
    supabaseAdmin.from('re_legal_cases').select('id').eq('organization_id', orgId).in('reservation_id', reservationIds).gte('created_at', since),
  ]);

  const count = (disputedSnags || []).length + (brokenPromises || []).length + (legalCases || []).length;
  return {
    disputed_snags: (disputedSnags || []).length,
    broken_promises: (brokenPromises || []).length,
    legal_cases_opened: (legalCases || []).length,
    points: scale(count, 5, 0, WEIGHTS.buyer_complaints), // MORE complaints = FEWER points, hence the reversed bad/good order
  };
}

async function computeHealth(orgId, project) {
  const [milestone, engagement, collection, repActivity, complaints] = await Promise.all([
    milestoneFreshness(orgId, project),
    developerEngagement(orgId),
    collectionTrend(orgId, project),
    repActivityLevel(orgId, project),
    buyerComplaints(orgId, project),
  ]);

  const signals = {
    milestone_freshness: milestone,
    developer_engagement: engagement,
    collection_trend: collection,
    rep_activity: repActivity,
    buyer_complaints: complaints,
  };

  const score = clamp(
    milestone.points + engagement.points + collection.points + repActivity.points + complaints.points,
    0, 100
  );

  return { score, signals };
}

// Run once a day for every project in every org — see jobs/daily.js.
// Upserts on (project_id, computed_date) (migrations/038's unique index),
// so a re-run of the morning job the same day updates today's figure
// rather than appending a duplicate.
async function computeAndStoreForAllProjects() {
  const { data: projects, error } = await supabaseAdmin
    .from('re_projects').select('id, organization_id, created_at').neq('status', 'archived');
  if (error) throw error;

  let computed = 0;
  let warningTasksFiled = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const project of projects || []) {
    try {
      const { score, signals } = await computeHealth(project.organization_id, project);

      await supabaseAdmin
        .from('re_project_health')
        .upsert(
          { organization_id: project.organization_id, project_id: project.id, health_score: score, signals, computed_date: today },
          { onConflict: 'project_id,computed_date' }
        );
      computed += 1;

      if (score < WARNING_THRESHOLD) {
        const filed = await fileWarningTaskIfThreeConsecutiveDays(project, score, signals);
        if (filed) warningTasksFiled += 1;
      }
    } catch (err) {
      console.warn('[project-health] could not compute health for project', project.id, err.message);
    }
  }

  return { computed, warningTasksFiled };
}

// "When health score drops below 60 for 3 consecutive days: create a task
// for the owner." Checked against the last 3 STORED days (today's row,
// just written, plus the two before it) rather than re-computing history —
// today's write above is what makes this the third data point once it
// applies. Deduped by title so three mornings in a row files exactly one
// task, not three.
async function fileWarningTaskIfThreeConsecutiveDays(project, todayScore, todaySignals) {
  const { data: recent } = await supabaseAdmin
    .from('re_project_health')
    .select('health_score, computed_date')
    .eq('project_id', project.id)
    .order('computed_date', { ascending: false })
    .limit(CONSECUTIVE_DAYS_FOR_TASK);

  if (!recent || recent.length < CONSECUTIVE_DAYS_FOR_TASK) return false;
  if (!recent.every((r) => r.health_score < WARNING_THRESHOLD)) return false;

  const { data: team } = await supabaseAdmin.from('teams').select('owner_id').eq('id', project.organization_id).maybeSingle();
  const ownerId = team?.owner_id || project.organization_id;
  const { data: projectRow } = await supabaseAdmin.from('re_projects').select('name').eq('id', project.id).maybeSingle();

  const weakSignals = Object.entries(todaySignals)
    .filter(([, s]) => s.points < WEIGHTS.milestone_freshness * 0.5)
    .map(([key]) => key.replace(/_/g, ' '));

  const title = `Project health warning — ${projectRow?.name || 'a project'}`;
  const { data: existingOpen } = await supabaseAdmin
    .from('re_tasks').select('id').eq('organization_id', project.organization_id).eq('title', title).eq('status', 'open').limit(1);
  if (existingOpen && existingOpen.length) return false;

  await supabaseAdmin.from('re_tasks').insert({
    organization_id: project.organization_id,
    title,
    notes: `Health score has been below ${WARNING_THRESHOLD} for ${CONSECUTIVE_DAYS_FOR_TASK} consecutive days (currently ${todayScore}). `
      + (weakSignals.length ? `Weakest signals: ${weakSignals.join(', ')}.` : ''),
    assigned_to: ownerId,
    source: 'ai',
  });

  auditSystem({
    orgId: project.organization_id,
    action: 'projectHealth.warning_filed',
    entityType: 're_project_health',
    entityId: project.id,
    summary: `${projectRow?.name || 'Project'} flagged — health score below ${WARNING_THRESHOLD} for ${CONSECUTIVE_DAYS_FOR_TASK} consecutive days`,
  });

  return true;
}

async function getLatestHealth(orgId, projectId) {
  const { data, error } = await supabaseAdmin
    .from('re_project_health')
    .select('*')
    .eq('organization_id', orgId)
    .eq('project_id', projectId)
    .order('computed_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Dashboard's "below 40" warning card, owner only — every project currently
// in that state, in one call rather than one per project.
async function criticalProjects(orgId) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin
    .from('re_project_health')
    .select('project_id, health_score, computed_date, re_projects(name)')
    .eq('organization_id', orgId)
    .eq('computed_date', today)
    .lt('health_score', CRITICAL_THRESHOLD);
  if (error) throw error;
  return (data || []).map((row) => ({ project_id: row.project_id, project_name: row.re_projects?.name || 'Project', health_score: row.health_score }));
}

// Portal notice: "has been below 40 for 14+ consecutive days" — read the
// same way the 3-day task check is, off stored history rather than
// recomputing anything. Returns the milestone-freshness day count too, so
// the buyer-facing message (portal.js) can say a specific number of days
// rather than just "a while" — worded generically everywhere else (never
// "health score", never the number 40) per this file's own reasoning above.
async function portalNoticeFor(orgId, projectId) {
  const { data } = await supabaseAdmin
    .from('re_project_health')
    .select('health_score, signals')
    .eq('organization_id', orgId)
    .eq('project_id', projectId)
    .order('computed_date', { ascending: false })
    .limit(CONSECUTIVE_DAYS_FOR_PORTAL_NOTICE);

  const critical = Boolean(data && data.length === CONSECUTIVE_DAYS_FOR_PORTAL_NOTICE
    && data.every((r) => r.health_score < CRITICAL_THRESHOLD));
  if (!critical) return null;

  return { days_since_update: data[0]?.signals?.milestone_freshness?.days_since_update ?? null };
}

// "Include project health summary in the Monday morning brief for the
// owner." Every project's TODAY figure, not just the critical ones — a
// Monday summary is meant to be glanced at as a whole-portfolio check-in,
// not just an alarm list (criticalProjects above is the alarm list, used by
// the dashboard's warning card instead).
async function summaryForBrief(orgId) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabaseAdmin
    .from('re_project_health')
    .select('project_id, health_score, re_projects(name)')
    .eq('organization_id', orgId)
    .eq('computed_date', today);

  const rows = (data || []).map((r) => ({
    project_name: r.re_projects?.name || 'Project',
    health_score: r.health_score,
    status: r.health_score < CRITICAL_THRESHOLD ? 'critical' : r.health_score < WARNING_THRESHOLD ? 'warning' : 'healthy',
  }));

  return {
    projects: rows,
    critical_count: rows.filter((r) => r.status === 'critical').length,
    warning_count: rows.filter((r) => r.status === 'warning').length,
  };
}

module.exports = {
  WEIGHTS, WARNING_THRESHOLD, CRITICAL_THRESHOLD, CONSECUTIVE_DAYS_FOR_TASK, CONSECUTIVE_DAYS_FOR_PORTAL_NOTICE,
  scale, computeHealth, computeAndStoreForAllProjects, getLatestHealth, criticalProjects, portalNoticeFor,
  summaryForBrief,
};
