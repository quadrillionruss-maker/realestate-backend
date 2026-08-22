// onboardingService.js — SECTION 23, a workspace's own setup checklist.
//
// Computed entirely from data that already exists — no new table, so there
// is nothing here to fall out of sync with the workspace actually doing the
// thing each step describes. One function, two callers: the operator's own
// dashboard (routes/dashboard.js, always the caller's own req.orgId) and the
// platform admin's Workspaces tab (routes/admin.js, any org by id) — sharing
// it means the two screens can never disagree about what "done" means.

const { supabaseAdmin, supabaseRaw } = require('../middleware/orgContext');

const STEPS = [
  { key: 'project_created', label: 'Create your first project' },
  { key: 'units_added', label: 'Add units to a project' },
  { key: 'buyer_added', label: 'Add a buyer' },
  { key: 'reservation_created', label: 'Reserve a unit for a buyer' },
  { key: 'payment_recorded', label: 'Record a payment' },
  { key: 'branding_configured', label: 'Set your company name and branding' },
  { key: 'team_invited', label: 'Invite a team member' },
  { key: 'brief_generated', label: 'Generate your first daily brief' },
];

async function checklist(orgId) {
  const results = await Promise.all([
    supabaseAdmin.from('re_projects').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabaseAdmin.from('re_units').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabaseAdmin.from('re_customers').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabaseAdmin.from('re_reservations').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabaseAdmin.from('re_payments').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).is('voided_at', null),
    supabaseAdmin.from('re_org_settings').select('company_name').eq('organization_id', orgId).maybeSingle(),
    // An invitation is the action this step asks the owner to take. A pending
    // invite must count here; otherwise the checklist appears broken until a
    // recipient creates an account and accepts it. The owner's membership is
    // included too, so a team needs at least two non-removed rows to finish.
    supabaseRaw.from('team_members').select('id', { count: 'exact', head: true }).eq('team_id', orgId).in('status', ['active', 'invited']),
    supabaseAdmin.from('re_ai_briefs').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
  ]);

  const failed = results.find((result) => result.error);
  if (failed) throw failed.error;

  const [
    { count: projectCount },
    { count: unitCount },
    { count: buyerCount },
    { count: reservationCount },
    { count: paymentCount },
    { data: settings },
    { count: memberOrInviteCount },
    { count: briefCount },
  ] = results;

  return buildChecklist({
    projectCount, unitCount, buyerCount, reservationCount, paymentCount,
    settings, memberOrInviteCount, briefCount,
  });
}

function buildChecklist({
  projectCount, unitCount, buyerCount, reservationCount, paymentCount,
  settings, memberOrInviteCount, briefCount,
}) {
  const done = {
    project_created: Boolean(projectCount),
    units_added: Boolean(unitCount),
    buyer_added: Boolean(buyerCount),
    reservation_created: Boolean(reservationCount),
    payment_recorded: Boolean(paymentCount),
    branding_configured: Boolean(settings?.company_name && String(settings.company_name).trim()),
    team_invited: Number(memberOrInviteCount || 0) > 1,
    brief_generated: Boolean(briefCount),
  };

  const steps = STEPS.map((step) => ({ ...step, done: done[step.key] }));
  return {
    steps,
    completed_count: steps.filter((s) => s.done).length,
    total_count: steps.length,
  };
}

module.exports = { checklist, buildChecklist, STEPS };
