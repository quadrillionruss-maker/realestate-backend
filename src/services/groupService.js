// groupService.js — the group owner's consolidated read across branches.
//
// Every branch stays exactly as isolated as it always was: nothing here lets
// a branch's own screens see another branch's rows, and no per-branch query
// anywhere else in the app changes shape because this file exists. This is
// the one deliberate exception — a group owner reading the SUM of several
// organization_id scopes they themselves own — and it is scoped by
// parent_organizations.owner_id, never by anything the caller can pass in.
//
// The math mirrors src/routes/reports.js's investor report exactly (same
// gross_development_value / contracted_value / collected_total /
// receivables_overdue definitions), just aggregated over several
// organization_id values (branches) instead of several project_id values
// within one. A branch owner's own investor report and the group owner's
// per-branch row for that same branch should always agree.
const { supabaseAdmin } = require('../middleware/orgContext');

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

const firstPlan = (reservation) =>
  Array.isArray(reservation.re_installment_plans)
    ? reservation.re_installment_plans[0]
    : reservation.re_installment_plans;

const emptyTotals = () => ({
  branches: 0, total_buyers: 0, gross_development_value: 0,
  contracted_value: 0, collected_total: 0, collected_this_month: 0,
  receivables_outstanding: 0, receivables_overdue: 0,
});

// A person can in principle own more than one group; every branch under
// every group they own rolls into one consolidated read. There is no
// "just this group" scope because nothing in the product currently needs to
// tell two groups apart from the owner's own seat — see GET /group/dashboard.
async function getGroupsOwnedBy(userId) {
  const { data, error } = await supabaseAdmin
    .from('parent_organizations')
    .select('id, name, created_at')
    .eq('owner_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// A person who has been explicitly granted one or more branches (see
// grantBranchAccess below) but does not own the group itself. Defensive
// against a branch that has since left its group: a grant's own group_id
// must still match the branch's CURRENT parent_organization_id, not just
// whatever it was at grant time — same reasoning as the migration's header.
async function getBranchesGrantedTo(userId) {
  const { data, error } = await supabaseAdmin
    .from('re_branch_access_grants')
    .select('team_id, group_id, teams(id, name, parent_organization_id), parent_organizations(name)')
    .eq('user_id', userId)
    .eq('status', 'active');
  if (error) throw error;
  return (data || [])
    .filter((row) => row.teams && row.teams.parent_organization_id === row.group_id)
    .map((row) => ({
      team_id: row.team_id,
      name: row.teams.name,
      group_id: row.group_id,
      group_name: row.parent_organizations?.name || null,
    }));
}

// The math shared by both a group owner's full roll-up and a grantee's
// narrower one — same gross_development_value / contracted_value /
// collected_total / receivables_overdue definitions either way, so a branch's
// own investor report, the owner's per-branch row and a grantee's per-branch
// row for that same branch can never disagree with each other.
async function buildDashboard(groups, branchRows) {
  if (!branchRows.length) return { groups, branches: [], totals: emptyTotals() };

  const branchIds = branchRows.map((b) => b.id);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';

  const [unitsRes, reservationsRes, paymentsRes, customersRes] = await Promise.all([
    supabaseAdmin.from('re_units').select('organization_id, list_price').in('organization_id', branchIds),
    supabaseAdmin.from('re_reservations')
      .select(`
        organization_id, status,
        re_units!inner(list_price),
        re_installment_plans(total_amount, re_installment_schedule(amount_due, status))`)
      .in('organization_id', branchIds),
    supabaseAdmin.from('re_payments')
      .select('organization_id, amount, paid_at')
      .in('organization_id', branchIds)
      .is('voided_at', null),
    supabaseAdmin.from('re_customers').select('organization_id, id').in('organization_id', branchIds),
  ]);
  for (const r of [unitsRes, reservationsRes, paymentsRes, customersRes]) {
    if (r.error) throw r.error;
  }

  const units = unitsRes.data || [];
  const reservations = reservationsRes.data || [];
  const payments = paymentsRes.data || [];
  const customers = customersRes.data || [];

  const branches = branchRows.map((branch) => {
    const branchUnits = units.filter((u) => u.organization_id === branch.id);
    const branchReservations = reservations.filter((r) => r.organization_id === branch.id);
    const branchPayments = payments.filter((p) => p.organization_id === branch.id);
    const branchCustomers = customers.filter((c) => c.organization_id === branch.id);

    const contracted = branchReservations
      .filter((r) => r.status !== 'cancelled')
      .reduce((total, r) => total + Number(firstPlan(r)?.total_amount || r.re_units?.list_price || 0), 0);

    let overdueAmount = 0;
    let scheduledRemaining = 0;
    for (const reservation of branchReservations) {
      if (reservation.status === 'cancelled') continue;
      for (const row of firstPlan(reservation)?.re_installment_schedule || []) {
        if (row.status === 'overdue') overdueAmount += Number(row.amount_due || 0);
        if (row.status === 'pending' || row.status === 'overdue') scheduledRemaining += Number(row.amount_due || 0);
      }
    }

    const collected = sum(branchPayments, 'amount');

    return {
      branch_id: branch.id,
      name: branch.name,
      total_buyers: branchCustomers.length,
      gross_development_value: round2(sum(branchUnits, 'list_price')),
      contracted_value: round2(contracted),
      collected_total: round2(collected),
      collected_this_month: round2(
        sum(branchPayments.filter((p) => (p.paid_at || '').slice(0, 10) >= monthStart), 'amount')
      ),
      receivables_outstanding: round2(scheduledRemaining),
      receivables_overdue: round2(overdueAmount),
    };
  });

  const totals = branches.reduce((totals, row) => ({
    branches: totals.branches + 1,
    total_buyers: totals.total_buyers + row.total_buyers,
    gross_development_value: round2(totals.gross_development_value + row.gross_development_value),
    contracted_value: round2(totals.contracted_value + row.contracted_value),
    collected_total: round2(totals.collected_total + row.collected_total),
    collected_this_month: round2(totals.collected_this_month + row.collected_this_month),
    receivables_outstanding: round2(totals.receivables_outstanding + row.receivables_outstanding),
    receivables_overdue: round2(totals.receivables_overdue + row.receivables_overdue),
  }), emptyTotals());

  return { groups, branches, totals };
}

// GET /group/dashboard's one entry point. An owner sees every branch under
// every group they own (unchanged from before grants existed); someone with
// no group of their own but one or more explicit grants sees only the
// branches named in those grants, possibly spanning groups they do not own
// at all. The two are mutually exclusive by construction — ownership is
// always the wider access, so an owner who also happens to hold a grant on
// one of their own branches gains nothing from it.
async function getDashboard(userId) {
  const ownedGroups = await getGroupsOwnedBy(userId);
  if (ownedGroups.length) {
    const groupIds = ownedGroups.map((g) => g.id);
    const { data: branchRows, error } = await supabaseAdmin
      .from('teams')
      .select('id, name, parent_organization_id')
      .in('parent_organization_id', groupIds);
    if (error) throw error;
    const dashboard = await buildDashboard(ownedGroups, branchRows || []);
    return { is_group_owner: true, is_branch_viewer: false, ...dashboard };
  }

  const granted = await getBranchesGrantedTo(userId);
  if (!granted.length) return null;

  const grantedGroupIds = [...new Set(granted.map((g) => g.group_id))];
  const { data: groupRows, error: groupErr } = await supabaseAdmin
    .from('parent_organizations')
    .select('id, name, created_at')
    .in('id', grantedGroupIds);
  if (groupErr) throw groupErr;

  const branchRows = granted.map((g) => ({ id: g.team_id, name: g.name, parent_organization_id: g.group_id }));
  const dashboard = await buildDashboard(groupRows || [], branchRows);
  return { is_group_owner: false, is_branch_viewer: true, ...dashboard };
}

// A group owner knows the person they want to grant by email, same as every
// other "add someone" flow in this product (invites, team management) — a
// raw user id is also accepted, for a caller that already has one on hand.
async function resolveGranteeId({ userId, email }) {
  if (userId) {
    const { data, error } = await supabaseAdmin.from('users').select('id').eq('id', userId).maybeSingle();
    if (error) throw error;
    return data ? data.id : null;
  }
  const trimmed = String(email || '').trim().toLowerCase();
  if (!trimmed) return null;
  const { data, error } = await supabaseAdmin.from('users').select('id').eq('email', trimmed).maybeSingle();
  if (error) throw error;
  return data ? data.id : null;
}

// Owner-only (routes/group.js gates every one of these behind
// requirePermission('group.manage')). Grants a specific person read access to
// ONE branch's numbers on the group dashboard — not a role, not a
// team_members row, nothing they can act on inside that branch.
async function grantBranchAccess(granterId, teamId, grantee) {
  const { data: team, error: teamErr } = await supabaseAdmin
    .from('teams').select('id, parent_organization_id').eq('id', teamId).maybeSingle();
  if (teamErr) throw teamErr;
  if (!team || !team.parent_organization_id) {
    throw Object.assign(new Error('This workspace is not part of a group.'), { statusCode: 404 });
  }

  const { data: group, error: groupErr } = await supabaseAdmin
    .from('parent_organizations').select('id, owner_id').eq('id', team.parent_organization_id).maybeSingle();
  if (groupErr) throw groupErr;
  if (!group || group.owner_id !== granterId) {
    throw Object.assign(new Error('Group not found.'), { statusCode: 404 });
  }

  const userId = await resolveGranteeId(grantee);
  if (!userId) {
    throw Object.assign(new Error('No Archta account found for that person yet.'), { statusCode: 404 });
  }

  // Re-granting after a revoke re-activates the one row the partial unique
  // index allows for this (team_id, user_id) pair rather than inserting a
  // second one — see the migration's own comment.
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('re_branch_access_grants').select('id')
    .eq('team_id', teamId).eq('user_id', userId).maybeSingle();
  if (existingErr) throw existingErr;

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from('re_branch_access_grants')
      .update({ status: 'active', revoked_at: null, granted_by: granterId, group_id: group.id })
      .eq('id', existing.id)
      .select('id, group_id, team_id, user_id, status, created_at')
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabaseAdmin
    .from('re_branch_access_grants')
    .insert({ group_id: group.id, team_id: teamId, user_id: userId, granted_by: granterId })
    .select('id, group_id, team_id, user_id, status, created_at')
    .single();
  if (error) throw error;
  return data;
}

async function revokeBranchAccess(granterId, teamId, userId) {
  const { data: team, error: teamErr } = await supabaseAdmin
    .from('teams').select('id, parent_organization_id').eq('id', teamId).maybeSingle();
  if (teamErr) throw teamErr;
  if (!team || !team.parent_organization_id) {
    throw Object.assign(new Error('This workspace is not part of a group.'), { statusCode: 404 });
  }

  const { data: group, error: groupErr } = await supabaseAdmin
    .from('parent_organizations').select('owner_id').eq('id', team.parent_organization_id).maybeSingle();
  if (groupErr) throw groupErr;
  if (!group || group.owner_id !== granterId) {
    throw Object.assign(new Error('Group not found.'), { statusCode: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from('re_branch_access_grants')
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('team_id', teamId).eq('user_id', userId).eq('status', 'active')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('No active grant found for that user on this branch.'), { statusCode: 404 });
  return { id: data.id, team_id: teamId, user_id: userId, status: 'revoked' };
}

// Every active grant across every group the caller owns — the management
// list behind routes/group.js's GET /access. Joined for display so the
// frontend needs no second lookup per row.
async function listBranchGrants(granterId) {
  const ownedGroups = await getGroupsOwnedBy(granterId);
  if (!ownedGroups.length) return [];

  const groupIds = ownedGroups.map((g) => g.id);
  const { data, error } = await supabaseAdmin
    .from('re_branch_access_grants')
    .select('id, team_id, user_id, group_id, status, created_at, teams(name), users(full_name, email)')
    .in('group_id', groupIds)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data || []).map((row) => ({
    id: row.id,
    team_id: row.team_id,
    branch_name: row.teams?.name || null,
    user_id: row.user_id,
    user_name: row.users?.full_name || null,
    user_email: row.users?.email || null,
    group_id: row.group_id,
    created_at: row.created_at,
  }));
}

// Creates a group owned by the caller. A branch is attached later, one at a
// time, through attachBranch — not accepted here as a list — so each attach
// can be validated against that specific team's own membership.
async function createGroup(userId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw Object.assign(new Error('A group needs a name.'), { statusCode: 400 });

  const { data, error } = await supabaseAdmin
    .from('parent_organizations')
    .insert({ name: trimmed, owner_id: userId })
    .select('id, name, created_at')
    .single();
  if (error) throw error;
  return data;
}

// Folds an EXISTING workspace the caller already owns into a group they
// already own. Both ownership facts are checked here — owning the group
// alone is not enough to pull in a workspace somebody else runs, and owning
// the workspace alone is not enough to attach it to somebody else's group.
async function attachBranch(userId, groupId, teamId) {
  const { data: group, error: groupErr } = await supabaseAdmin
    .from('parent_organizations').select('id, owner_id').eq('id', groupId).maybeSingle();
  if (groupErr) throw groupErr;
  if (!group || group.owner_id !== userId) {
    throw Object.assign(new Error('Group not found.'), { statusCode: 404 });
  }

  const { data: membership, error: memberErr } = await supabaseAdmin
    .from('team_members').select('role, status')
    .eq('team_id', teamId).eq('user_id', userId).maybeSingle();
  if (memberErr) throw memberErr;
  if (!membership || membership.status !== 'active' || membership.role !== 'owner') {
    throw Object.assign(new Error('You must be the owner of a workspace to add it as a branch.'), { statusCode: 403 });
  }

  const { data, error } = await supabaseAdmin
    .from('teams')
    .update({ parent_organization_id: groupId })
    .eq('id', teamId)
    .select('id, name, parent_organization_id')
    .single();
  if (error) throw error;
  return data;
}

// Reversible, same as everything else in this product — a branch that
// leaves a group keeps every buyer, payment and document exactly as they
// were; only the roll-up stops counting it.
async function detachBranch(userId, teamId) {
  const { data: team, error: teamErr } = await supabaseAdmin
    .from('teams').select('id, parent_organization_id').eq('id', teamId).maybeSingle();
  if (teamErr) throw teamErr;
  if (!team || !team.parent_organization_id) {
    throw Object.assign(new Error('This workspace is not part of a group.'), { statusCode: 404 });
  }

  const { data: group, error: groupErr } = await supabaseAdmin
    .from('parent_organizations').select('owner_id').eq('id', team.parent_organization_id).maybeSingle();
  if (groupErr) throw groupErr;
  if (!group || group.owner_id !== userId) {
    throw Object.assign(new Error('Group not found.'), { statusCode: 404 });
  }

  const { error } = await supabaseAdmin
    .from('teams').update({ parent_organization_id: null }).eq('id', teamId);
  if (error) throw error;
  return { id: teamId, parent_organization_id: null };
}

module.exports = {
  getGroupsOwnedBy, getDashboard, createGroup, attachBranch, detachBranch,
  getBranchesGrantedTo, grantBranchAccess, revokeBranchAccess, listBranchGrants,
};
