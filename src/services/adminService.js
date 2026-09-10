// adminService.js — platform-operator queries, across every workspace at once.
//
// Everything here uses supabaseRaw (via orgContext's supabaseAdmin, which only
// auto-filters deleted_at on tables it recognizes — see that file's own
// comment) with NO organization_id filter anywhere. That is the entire point
// of this file and also its entire risk: nothing downstream of
// src/routes/admin.js may ever be reachable without the ADMIN_SECRET check
// that route file gates every path behind.
//
// Read endpoints return plain arrays/objects, matching the rest of this
// codebase's convention (routes/reports.js and friends) rather than a
// {success:true, data:...} envelope.

const crypto = require('crypto');
const { supabaseAdmin: db, supabaseRaw } = require('../middleware/orgContext');
const { hashPassword, issueToken, MIN_PASSWORD_LENGTH, activeOrgIdsFor } = require('./authService');
const { auditSystem } = require('./auditService');
const featureUsageService = require('./featureUsageService');
const notify = require('./notificationService');

const notFound = (message) => Object.assign(new Error(message), { statusCode: 404 });
const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const conflict = (message) => Object.assign(new Error(message), { statusCode: 409 });

// TASK 3 AUDIT FIX (Critical #2) — the platform-level companion to
// auditSystem(), for exactly the actions auditSystem cannot durably record:
// anything that might delete the very re_audit_log row auditSystem would
// have written (a full workspace wipe), or anything with no single
// organization_id to scope to at all. Never fails the action it is
// recording, same discipline auditService.write() itself follows.
async function logAdminAction({ action, targetOrgId = null, targetUserEmail = null, summary = null, metadata = {} }) {
  try {
    await supabaseRaw.from('re_admin_actions').insert({
      action,
      target_org_id: targetOrgId,
      target_user_email: targetUserEmail,
      summary,
      metadata,
    });
  } catch (err) {
    console.warn(`[admin] could not record admin action "${action}":`, err.message);
  }
}

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const sevenDaysAgo = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const startOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
};

// ── Overview ────────────────────────────────────────────────────────────────
async function overview() {
  const [
    { count: totalWorkspaces },
    { count: totalUsers },
    { count: activeWorkspaces },
    { count: totalBuyers },
    { count: totalPayments },
    // AUDIT FIX (P2) — used to fetch the `amount` column of every
    // non-voided payment on the whole platform just to sum it here; the
    // sum is now computed in Postgres (migrations/068).
    { data: totalCollectionsRow },
    { data: lastRun },
  ] = await Promise.all([
    supabaseRaw.from('teams').select('id', { count: 'exact', head: true }),
    supabaseRaw.from('users').select('id', { count: 'exact', head: true }),
    supabaseRaw.from('users').select('id', { count: 'exact', head: true }).gte('last_login_at', sevenDaysAgo()),
    db.from('re_customers').select('id', { count: 'exact', head: true }),
    db.from('re_payments').select('id', { count: 'exact', head: true }).is('voided_at', null),
    supabaseRaw.rpc('admin_total_collections'),
    supabaseRaw.from('re_cron_runs').select('job_name, started_at, finished_at').order('started_at', { ascending: false }).limit(1),
  ]);

  // Workspaces here means teams; a solo account (no teams row) is still a
  // real workspace but is counted through totalUsers instead — team count
  // alone would undercount the platform by every solo signup.
  const totalCollections = Number(totalCollectionsRow || 0);

  return {
    total_workspaces: totalWorkspaces || 0,
    total_users: totalUsers || 0,
    active_workspaces_7d: activeWorkspaces || 0,
    total_buyers: totalBuyers || 0,
    total_payments: totalPayments || 0,
    total_collections: totalCollections,
    last_cron_run: lastRun?.[0] || null,
  };
}

// ── Workspaces ──────────────────────────────────────────────────────────────
// One row per team PLUS one row per solo account (a user with no active team
// membership at all) — otherwise a solo developer, the majority of a
// self-serve product's signups, would simply not appear in this table.
async function listWorkspaces() {
  const [{ data: teams, error: teamsErr }, { data: members, error: membersErr }, { data: users, error: usersErr }] = await Promise.all([
    supabaseRaw.from('teams').select('id, name, owner_id, created_at'),
    supabaseRaw.from('team_members').select('team_id, user_id, status'),
    supabaseRaw.from('users').select('id, email, full_name, last_login_at, created_at'),
  ]);
  if (teamsErr) throw teamsErr;
  if (membersErr) throw membersErr;
  if (usersErr) throw usersErr;

  const userById = new Map((users || []).map((u) => [u.id, u]));
  const activeMemberIds = new Set(
    (members || []).filter((m) => m.status === 'active').map((m) => m.user_id)
  );

  const orgIds = [
    ...(teams || []).map((t) => t.id),
    // Solo: a user with no ACTIVE team_members row anywhere. Their
    // organization_id (resolveOrgId) is their own id.
    ...(users || []).filter((u) => !activeMemberIds.has(u.id)).map((u) => u.id),
  ];

  if (!orgIds.length) return [];

  // AUDIT FIX (P1) — this used to fetch the full organization_id column of
  // five platform-wide tables (including re_ai_briefs, which gains a new
  // row per org every single day forever) just to count rows per org here.
  // admin_workspace_counts (migrations/068) returns one already-grouped row
  // per organization instead of one row per underlying record.
  const [
    { data: workspaceCounts, error: countsErr },
    { data: briefs, error: briefErr },
    { data: agentActions, error: agentErr },
    { data: settings, error: settingsErr },
  ] = await Promise.all([
    supabaseRaw.rpc('admin_workspace_counts'),
    supabaseRaw.from('re_ai_briefs').select('organization_id, created_at').order('created_at', { ascending: false }),
    supabaseRaw.from('re_agent_actions').select('organization_id').gte('created_at', sevenDaysAgo()),
    supabaseRaw.from('re_org_settings').select('organization_id, whatsapp_token_encrypted, paystack_secret_key_encrypted'),
  ]);
  if (countsErr) throw countsErr;
  if (briefErr) throw briefErr;
  if (agentErr) throw agentErr;
  if (settingsErr) throw settingsErr;

  const countBy = (rows) => {
    const map = new Map();
    for (const row of rows || []) map.set(row.organization_id, (map.get(row.organization_id) || 0) + 1);
    return map;
  };
  const projectCounts = new Map((workspaceCounts || []).map((r) => [r.organization_id, Number(r.project_count)]));
  const unitCounts = new Map((workspaceCounts || []).map((r) => [r.organization_id, Number(r.unit_count)]));
  const customerCounts = new Map((workspaceCounts || []).map((r) => [r.organization_id, Number(r.customer_count)]));
  const reservationCounts = new Map((workspaceCounts || []).map((r) => [r.organization_id, Number(r.reservation_count)]));
  const paymentCounts = new Map((workspaceCounts || []).map((r) => [r.organization_id, Number(r.payment_count)]));
  const agentActionCounts = countBy(agentActions);

  const lastBriefByOrg = new Map();
  for (const row of briefs || []) {
    if (!lastBriefByOrg.has(row.organization_id)) lastBriefByOrg.set(row.organization_id, row.created_at);
  }
  const settingsByOrg = new Map((settings || []).map((s) => [s.organization_id, s]));

  const rows = (teams || []).map((team) => {
    const owner = team.owner_id ? userById.get(team.owner_id) : null;
    const memberCount = (members || []).filter((m) => m.team_id === team.id && m.status === 'active').length;
    const orgSettings = settingsByOrg.get(team.id);
    return workspaceRow({
      orgId: team.id,
      name: team.name,
      ownerEmail: owner?.email || null,
      ownerLastLogin: owner?.last_login_at || null,
      createdAt: team.created_at,
      memberCount,
      projectCounts, unitCounts, customerCounts, reservationCounts, paymentCounts,
      agentActionCounts, lastBriefByOrg, orgSettings,
    });
  });

  for (const user of users || []) {
    if (activeMemberIds.has(user.id)) continue; // covered by a team row above
    const orgSettings = settingsByOrg.get(user.id);
    rows.push(workspaceRow({
      orgId: user.id,
      name: user.full_name || user.email,
      ownerEmail: user.email,
      ownerLastLogin: user.last_login_at,
      createdAt: user.created_at,
      memberCount: 1,
      projectCounts, unitCounts, customerCounts, reservationCounts, paymentCounts,
      agentActionCounts, lastBriefByOrg, orgSettings,
    }));
  }

  return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function workspaceRow({
  orgId, name, ownerEmail, ownerLastLogin, createdAt, memberCount,
  projectCounts, unitCounts, customerCounts, reservationCounts, paymentCounts,
  agentActionCounts, lastBriefByOrg, orgSettings,
}) {
  return {
    organization_id: orgId,
    name,
    owner_email: ownerEmail,
    owner_last_login: ownerLastLogin,
    created_at: createdAt,
    member_count: memberCount,
    project_count: projectCounts.get(orgId) || 0,
    unit_count: unitCounts.get(orgId) || 0,
    buyer_count: customerCounts.get(orgId) || 0,
    reservation_count: reservationCounts.get(orgId) || 0,
    payment_count: paymentCounts.get(orgId) || 0,
    brief_last_generated_at: lastBriefByOrg.get(orgId) || null,
    agent_actions_7d: agentActionCounts.get(orgId) || 0,
    whatsapp_configured: Boolean(orgSettings?.whatsapp_token_encrypted),
    paystack_configured: Boolean(orgSettings?.paystack_secret_key_encrypted),
  };
}

// ── Users ───────────────────────────────────────────────────────────────────
async function listUsers() {
  const [{ data: users, error: usersErr }, { data: teams, error: teamsErr }, { data: members, error: membersErr }] = await Promise.all([
    supabaseRaw.from('users').select('id, email, full_name, created_at, last_login_at'),
    supabaseRaw.from('teams').select('id, name'),
    supabaseRaw.from('team_members').select('user_id, team_id, role, status'),
  ]);
  if (usersErr) throw usersErr;
  if (teamsErr) throw teamsErr;
  if (membersErr) throw membersErr;

  const teamById = new Map((teams || []).map((t) => [t.id, t]));
  const membershipByUser = new Map();
  for (const m of members || []) {
    if (m.status !== 'active') continue;
    if (!membershipByUser.has(m.user_id)) membershipByUser.set(m.user_id, m);
  }

  return (users || []).map((u) => {
    const membership = membershipByUser.get(u.id);
    const team = membership ? teamById.get(membership.team_id) : null;
    return {
      id: u.id,
      email: u.email,
      full_name: u.full_name,
      created_at: u.created_at,
      last_login_at: u.last_login_at,
      workspace_name: team ? team.name : (u.full_name || u.email),
      role: membership ? membership.role : 'owner', // solo account owns its own workspace outright
    };
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// activeOrgIdsFor (which workspace(s) an audit entry about this user
// belongs in) now lives in authService.js — AUDIT FIX (C4) reuses the exact
// same resolution for a person's own security actions in routes/auth.js,
// rather than a second, drifting copy of this query.

// Generates a real random password rather than a guessable pattern — this is
// handed back once, in the response, for the admin to relay to whoever
// actually owns the account; it is never emailed (this deployment's Resend
// account cannot reliably reach a real user — see CLAUDE.md's "Sign-up and
// sign-in") and never logged.
function randomPassword() {
  // Base64url avoids characters (like `/`) that read ambiguously read aloud
  // or copy badly out of a terminal; 18 bytes clears MIN_PASSWORD_LENGTH
  // (12) with headroom.
  return crypto.randomBytes(18).toString('base64url');
}

async function resetUserPassword(userId) {
  const { data: user, error: findErr } = await supabaseRaw.from('users').select('id, email').eq('id', userId).maybeSingle();
  if (findErr) throw findErr;
  if (!user) throw notFound('User not found.');

  const password = randomPassword();

  // A reset issued from outside the account itself must not leave every
  // other open session standing — same reasoning authService's own
  // password-change path already applies to a self-service reset.
  // supabase-js has no atomic increment (authService.bumpTokenVersion works
  // around the same gap) — read-then-write is fine here since this is an
  // already-serialized admin action, not a concurrent hot path.
  const { data: current, error: readErr } = await supabaseRaw.from('users').select('token_version').eq('id', userId).maybeSingle();
  if (readErr) throw readErr;

  const { error } = await supabaseRaw.from('users').update({
    password_hash: await hashPassword(password),
    token_version: Number(current?.token_version || 0) + 1,
  }).eq('id', userId);
  if (error) throw error;

  // TASK 3 AUDIT FIX (Important #8) — an account-takeover-capable action
  // (any platform user's password, reset and handed back in cleartext) used
  // to leave only a console.log line, gone once Render's retention rolls
  // it off. Written into every workspace this affects, the same durable,
  // queryable mechanism a self-service password change already gets.
  for (const orgId of await activeOrgIdsFor(userId)) {
    await auditSystem({
      orgId,
      actorKind: 'admin',
      action: 'admin.password_reset',
      entityType: 'users',
      entityId: userId,
      summary: `${user.email}'s password was reset by a platform admin.`,
    });
  }

  // user.email intentionally omitted here — see hardDeleteUser's own comment
  // on why an operational console.log is the wrong place for it; the audit
  // entries above are the durable, PII-appropriate record.
  console.log(`[admin] password reset for user ${userId}`);
  return { email: user.email, password };
}

// The one true hard delete in this product. See migrations/039_admin.sql's
// header for why the multi-table part of this is a database function rather
// than a sequence of calls from here.
async function hardDeleteUser(userId) {
  const { data: user, error: findErr } = await supabaseRaw.from('users').select('id, email').eq('id', userId).maybeSingle();
  if (findErr) throw findErr;
  if (!user) throw notFound('User not found.');

  const { data: memberships, error: memErr } = await supabaseRaw
    .from('team_members')
    .select('team_id, status')
    .eq('user_id', userId);
  if (memErr) throw memErr;

  const activeTeamIds = (memberships || []).filter((m) => m.status === 'active').map((m) => m.team_id);

  // For every workspace this user is the LAST active member of (including
  // their own solo workspace, which has no team_members row at all), wipe
  // that workspace's data before removing them — see the migration for why
  // this can't be left to the users(id) cascade alone (organization_id on
  // domain tables carries no foreign key by design, per CLAUDE.md's org-
  // scoping section). Any workspace where someone else is still active is
  // left completely alone.
  const orgsToWipe = [];
  for (const teamId of activeTeamIds) {
    const { count } = await supabaseRaw
      .from('team_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('team_id', teamId)
      .eq('status', 'active')
      .neq('user_id', userId);
    if (!count) orgsToWipe.push(teamId);
  }
  if (!activeTeamIds.length) orgsToWipe.push(userId); // solo account: org id is their own id
  const orgsToWipeSet = new Set(orgsToWipe);

  // TASK 3 AUDIT FIX (Critical #3) — every workspace this user is (or was)
  // an active member of gets a durable record that they were removed, not
  // just the ones being wiped below. A shared team's OWN re_audit_log
  // survives this (only a fully-wiped workspace's does not), so auditSystem
  // is the right, durable mechanism here — the platform-level log below is
  // only for the wipe case, where re_audit_log itself is about to be gone.
  for (const teamId of activeTeamIds) {
    if (orgsToWipeSet.has(teamId)) continue; // covered by logAdminAction below instead
    await auditSystem({
      orgId: teamId,
      actorKind: 'admin',
      action: 'admin.user_removed',
      entityType: 'users',
      entityId: null,
      summary: `${user.email} was permanently removed from this workspace by a platform admin.`,
    });
  }

  for (const orgId of orgsToWipe) {
    // TASK 3 AUDIT FIX (Critical #2) — this used to write into the org's own
    // re_audit_log, which admin_wipe_organization's own last statement then
    // deletes on every successful run, making the trace self-cancelling on
    // exactly the path it existed to cover. re_admin_actions is a separate,
    // platform-level table the wipe below cannot reach.
    await logAdminAction({
      action: 'admin.workspace_hard_deleted',
      targetOrgId: orgId,
      targetUserEmail: user.email,
      summary: `Workspace permanently deleted by platform admin, triggered by removing user ${user.email}.`,
    });
    const { data: wipeCounts, error: wipeErr } = await supabaseRaw.rpc('admin_wipe_organization', { target_org_id: orgId });
    if (wipeErr) throw wipeErr;
    console.log(`[admin] wiped organization ${orgId}:`, JSON.stringify(wipeCounts));
  }

  // Now the user row itself. team_members cascades (ON DELETE CASCADE); a
  // re_sales_reps row cascades too UNLESS it still has reservations
  // attached in a workspace that was deliberately left alone above — that
  // FK has no on-delete clause (RESTRICT by default), so it fails loudly
  // here rather than silently orphaning a shared team's commission trail.
  // Same for re_messages.sender_id, re_legal_cases.opened_by, and the
  // other RESTRICT-by-default personal references Task 3's audit flags.
  const { error: deleteErr } = await supabaseRaw.from('users').delete().eq('id', userId);
  if (deleteErr) {
    if (deleteErr.code === '23503') {
      throw conflict(
        'Cannot delete this user: they still have records referenced from a shared workspace '
        + '(a sales rep book with live reservations, sent buyer messages, an opened legal case, or similar). '
        + 'Reassign or resolve those first, or remove them from that workspace instead of hard-deleting the account.'
      );
    }
    throw deleteErr;
  }

  // TASK 3 AUDIT FIX (Important #7) — user.email removed from this line.
  // console.log reaches Render's ephemeral, non-access-controlled log
  // retention; a feature built to satisfy a right-to-erasure request must
  // not itself write the erased person's email there. userId is a stable,
  // non-PII identifier and is enough to correlate with the durable records
  // above (re_admin_actions for a wipe, re_audit_log for a shared removal).
  console.log(`[admin] hard-deleted user ${userId}; wiped ${orgsToWipe.length} workspace(s)`);
  return { deleted_user: user.email, workspaces_wiped: orgsToWipe.length };
}

// ── Impersonate ─────────────────────────────────────────────────────────────
// A short-lived token for the WORKSPACE OWNER specifically — not "any member",
// since the point is reproducing what the account owner sees, and a team can
// have several members with different roles that would each see something
// different. `tv` (token_version) is read fresh, so a token minted here still
// respects a lock/removal that happens later the same way every other token
// does (src/middleware/auth.js).
//
// Single source of truth for the TTL, in both the form jwt.sign wants and the
// form the API response wants — a previous version of this function signed
// with issueToken(owner) alone (no override existed on that function at all),
// so the token was silently a full 30-day session while the response claimed
// 2 hours. Deriving IMPERSONATE_TTL_SECONDS from the same string jwt.sign
// consumes means the two can never drift apart again.
const IMPERSONATE_TTL = '2h';
const IMPERSONATE_TTL_SECONDS = 2 * 60 * 60;

async function impersonateWorkspace(orgId) {
  const { data: team } = await supabaseRaw.from('teams').select('id, owner_id').eq('id', orgId).maybeSingle();

  const ownerId = team ? team.owner_id : orgId; // no team row → orgId IS the (solo) owner's user id
  if (!ownerId) throw notFound('This workspace has no owner to impersonate.');

  const { data: owner, error } = await supabaseRaw.from('users').select('id, email, token_version').eq('id', ownerId).maybeSingle();
  if (error) throw error;
  if (!owner) throw notFound('Workspace owner not found.');

  const token = issueToken(owner, { expiresIn: IMPERSONATE_TTL });

  // The single most sensitive action this dashboard exposes — minting a
  // working credential indistinguishable from the real owner's own session —
  // previously left no trace anywhere. Written to the workspace's own audit
  // log (not a platform-level one): the owner is exactly who most needs to
  // be able to answer "was I ever impersonated, and when".
  await auditSystem({
    orgId,
    actorKind: 'admin',
    action: 'admin.workspace_impersonated',
    entityType: 'organization',
    entityId: null,
    summary: `Platform admin impersonated workspace owner ${owner.email} for up to ${IMPERSONATE_TTL}.`,
  });
  console.log(`[admin] impersonation token issued for workspace ${orgId} (owner ${ownerId})`);

  // AUDIT FIX (AD14) — the audit log entry just above is passive: the owner
  // only ever sees it if they go looking. Someone with ADMIN_SECRET holding
  // a token "indistinguishable from the real owner's own session" (this
  // function's own header, above) is exactly the kind of account access a
  // person should be told about as it happens, not something they might
  // never think to check for. Never lets a failed/unconfigured send turn
  // into a failed impersonation — sendEmail itself already never throws
  // (notificationService.js's own rule), so this is not wrapped further.
  const accessedAt = new Date().toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos',
  });
  await notify.sendEmail({
    orgId,
    to: owner.email,
    subject: 'Your Archta account was accessed by an administrator',
    html: notify.emailShell({
      heading: 'Administrator access notice',
      intro: `Your account was accessed by an Archta administrator at ${accessedAt} (Africa/Lagos time). `
        + 'This is a routine support action and does not change your password or any of your data. '
        + 'If you were not expecting this, contact support.',
      // Overrides emailShell's default footer ("...on behalf of your
      // property developer") — backwards for this one email: the
      // administrator here is Archta's own platform operator, not this
      // workspace's own staff.
      footer: 'Sent by Archta, the platform operator — not a message from your own workspace or staff.',
    }),
    relatedType: 'organization',
    relatedId: orgId,
  });

  return { token, user_email: owner.email, expires_in_seconds: IMPERSONATE_TTL_SECONDS };
}

// Runs the same generateDailyBrief() jobs/daily.js calls at 07:00, on demand,
// for one workspace — support diagnosing "why does today's brief look wrong"
// without waiting for tomorrow morning. Lazy require: aiBrief.js is a large
// module with its own web of service dependencies, none of which need to be
// loaded for every other admin route that never touches a brief.
async function sendTestBrief(orgId) {
  const [{ data: team }, { data: soloUser }] = await Promise.all([
    supabaseRaw.from('teams').select('id').eq('id', orgId).maybeSingle(),
    supabaseRaw.from('users').select('id').eq('id', orgId).maybeSingle(),
  ]);
  if (!team && !soloUser) throw notFound('Workspace not found.');

  const aiBrief = require('./aiBrief');
  const result = await aiBrief.generateDailyBrief(orgId);

  await auditSystem({
    orgId,
    actorKind: 'admin',
    action: 'admin.test_brief_sent',
    entityType: 'organization',
    entityId: null,
    summary: `Platform admin triggered an immediate brief regeneration (generated_by: ${result.generated_by}).`,
  });

  return { generated_by: result.generated_by, summary: result.summary };
}

// Deletes today's re_ai_briefs row (Africa/Lagos date, the same key
// storeBrief upserts on) for one workspace. Nothing regenerates it
// immediately — the next 07:00 cron run does, same as any other day this
// org never had a cached brief. Useful when a brief was generated before a
// data-affecting fix (a payment correction, a plan restructure) and would
// otherwise sit stale until tomorrow regardless of the underlying numbers
// having already changed.
async function resetBriefCache(orgId) {
  // AUDIT FIX (S3) — same existence check sendTestBrief above already makes.
  // Without it, a typo'd or stale orgId still writes an audit row claiming a
  // cache reset happened for a workspace that was never touched (the delete
  // above simply matches zero rows).
  const [{ data: team }, { data: soloUser }] = await Promise.all([
    supabaseRaw.from('teams').select('id').eq('id', orgId).maybeSingle(),
    supabaseRaw.from('users').select('id').eq('id', orgId).maybeSingle(),
  ]);
  if (!team && !soloUser) throw notFound('Workspace not found.');

  const { lagosToday } = require('./overdueService');
  const { error, count } = await supabaseRaw
    .from('re_ai_briefs')
    .delete({ count: 'exact' })
    .eq('organization_id', orgId)
    .eq('brief_date', lagosToday());
  if (error) throw error;

  await auditSystem({
    orgId,
    actorKind: 'admin',
    action: 'admin.brief_cache_reset',
    entityType: 'organization',
    entityId: null,
    summary: 'Platform admin cleared today\'s cached brief; it will regenerate at the next 07:00 run.',
  });

  return { cleared: Boolean(count) };
}

// ── Agents ──────────────────────────────────────────────────────────────────
async function agentActionsLog({ orgId, agentName, outcome } = {}) {
  let query = supabaseRaw
    .from('re_agent_actions')
    .select('id, agent_name, organization_id, customer_id, action_type, outcome, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (orgId) query = query.eq('organization_id', orgId);
  if (agentName) query = query.eq('agent_name', agentName);
  if (outcome) query = query.eq('outcome', outcome);

  const { data: rows, error } = await query;
  if (error) throw error;
  if (!rows?.length) return [];

  const orgIds = [...new Set(rows.map((r) => r.organization_id).filter(Boolean))];
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];

  const [{ data: teams }, { data: users }, { data: customers }] = await Promise.all([
    orgIds.length ? supabaseRaw.from('teams').select('id, name').in('id', orgIds) : Promise.resolve({ data: [] }),
    orgIds.length ? supabaseRaw.from('users').select('id, full_name, email').in('id', orgIds) : Promise.resolve({ data: [] }),
    customerIds.length ? db.from('re_customers').select('id, full_name').in('id', customerIds) : Promise.resolve({ data: [] }),
  ]);
  const teamById = new Map((teams || []).map((t) => [t.id, t.name]));
  const userById = new Map((users || []).map((u) => [u.id, u.full_name || u.email]));
  const customerById = new Map((customers || []).map((c) => [c.id, c.full_name]));

  return rows.map((r) => ({
    id: r.id,
    agent_name: r.agent_name,
    org_name: teamById.get(r.organization_id) || userById.get(r.organization_id) || r.organization_id,
    customer_name: customerById.get(r.customer_id) || null,
    action_type: r.action_type,
    outcome: r.outcome,
    created_at: r.created_at,
  }));
}

// ── Notifications ───────────────────────────────────────────────────────────
async function notificationStats() {
  // AUDIT FIX (P3) — this used to fetch the `channel` column of the
  // ENTIRE re_notifications table (append-only, retained forever per
  // CLAUDE.md's "Data retention" section) just to bucket counts by channel
  // in JavaScript; grouped in Postgres instead (migrations/068).
  const [{ count: total }, { count: failed }, { data: byChannelRows, error: byChannelErr }, { data: failedRows, error: failedErr }] = await Promise.all([
    supabaseRaw.from('re_notifications').select('id', { count: 'exact', head: true }),
    supabaseRaw.from('re_notifications').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    supabaseRaw.rpc('admin_notification_counts_by_channel'),
    // TASK 3 FOLLOW-UP FIX — the column is `error` (migrations/003), not
    // `reason`; nothing caught this at write time since supabase-js only
    // reports a bad column name once the query actually runs.
    supabaseRaw.from('re_notifications')
      .select('id, channel, recipient, error, created_at')
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);
  if (byChannelErr) throw byChannelErr;
  if (failedErr) throw failedErr;

  const byType = {};
  for (const row of byChannelRows || []) byType[row.channel] = Number(row.cnt);

  return {
    total_sent: total || 0,
    total_failed: failed || 0,
    failed_rate: total ? Number(((failed || 0) / total * 100).toFixed(2)) : 0,
    by_type: byType,
    recent_failures: failedRows || [],
  };
}

// ── Health ──────────────────────────────────────────────────────────────────
async function health() {
  const [{ data: lastRun }, { count: openaiCalls }, { count: failedWebhooks }, migrations] = await Promise.all([
    supabaseRaw.from('re_cron_runs').select('*').order('started_at', { ascending: false }).limit(1),
    supabaseRaw.from('re_agent_actions').select('id', { count: 'exact', head: true }).gte('created_at', startOfMonth()),
    supabaseRaw.from('re_notifications').select('id', { count: 'exact', head: true })
      .eq('status', 'failed').gte('created_at', sevenDaysAgo()),
    migrationStatus(),
  ]);

  return {
    last_cron_run: lastRun?.[0] || null,
    openai_calls_this_month: openaiCalls || 0,
    failed_webhooks_7d: failedWebhooks || 0,
    migrations,
  };
}

// Reads which migration files exist on disk and cross-references them
// against schema_migrations (migrations/082) — every migration from 001
// onward ends with `insert into schema_migrations values ('NNN_name.sql')
// on conflict do nothing`, so a file's row exists here the moment it has
// actually been pasted into the Supabase SQL editor and run. This replaced
// a hand-maintained map from file prefix to the table it creates
// (MIGRATION_CHECKPOINTS): that map required a new entry every time a
// migration added a table, went stale twice in practice (once caught and
// patched, once not — 073 through 081 shipped with no entry and read as
// "not applied" regardless of the database's real state), and would keep
// going stale by the same mechanism forever. A straight ledger lookup has
// nothing to fall behind.
//
// A database that has not yet run 082 (or the updated 001, which also
// creates schema_migrations — see that file's own header) has no ledger
// table at all; that read is treated as "nothing registered yet" rather
// than thrown, so the Health tab still renders instead of 500ing on a
// database mid-upgrade.
async function migrationStatus() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'migrations');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }

  const { data: rows, error } = await supabaseRaw.from('schema_migrations').select('filename');
  // 42P01 = undefined_table, the raw Postgres code. PGRST205 is PostgREST's
  // OWN code for the same situation ("Could not find the table ... in the
  // schema cache") — a plain .from().select() through Supabase's REST layer
  // surfaces this one, not 42P01, when the table genuinely does not exist
  // yet (or exists but PostgREST's schema cache has not reloaded since it
  // was created) — confirmed against a real Supabase project that had not
  // yet run 082. Either way: this database hasn't run 082/updated-001 yet.
  if (error && error.code !== '42P01' && error.code !== 'PGRST205') throw error;

  const applied = new Set((rows || []).map((r) => r.filename));
  return files.map((file) => ({ file, applied: applied.has(file) }));
}

// AUDIT FIX (AD7) — a real build identifier in the sidebar instead of a
// static "Archta Admin" label. process.env.npm_package_version is what npm
// sets when a script is launched via `npm start`/`npm run` (true for local
// dev — CLAUDE.md's own `npm start`) — but render.yaml's startCommand is
// `node server.js` directly, which npm never wraps, so that variable is
// unset in the one environment this label most needs to be right in.
// Falling back to reading package.json's own "version" field directly means
// the sidebar shows a real number either way, not a blank.
function version() {
  let pkgVersion = null;
  try {
    pkgVersion = require('../../package.json').version || null;
  } catch {
    pkgVersion = null;
  }
  return { version: process.env.npm_package_version || pkgVersion || 'unknown' };
}

// ── SECTION 21 — Archta's own subscription revenue ──────────────────────────
// NOT developer customer revenue — that is the rest of this product
// (re_payments, collected installments). This is what a WORKSPACE pays
// Archta, tracked in re_subscriptions (migrations/052), a platform-wide
// table this file is the only reader of.
async function revenue() {
  const monthStartIso = startOfMonth();

  const [{ data: active, error: activeErr }, { data: endedThisMonth, error: endedErr }, { data: activeStartOfMonth, error: startErr }, { data: allSubs, error: allErr }] = await Promise.all([
    supabaseRaw.from('re_subscriptions').select('organization_id, plan, monthly_amount').is('ended_at', null),
    supabaseRaw.from('re_subscriptions').select('id').gte('ended_at', monthStartIso),
    // "Active at the start of this month" — started before this month began,
    // and either still active or only ended on/after this month began. This
    // is the denominator both churn_rate and monthly_growth_rate below read
    // from, so the two numbers describe the same baseline.
    supabaseRaw.from('re_subscriptions').select('monthly_amount')
      .lt('started_at', monthStartIso)
      .or(`ended_at.is.null,ended_at.gte.${monthStartIso}`),
    // Every subscription this workspace has ever had, for the 12-month MRR
    // chart below — cheaper to read once and bucket in memory than to run
    // twelve separate range queries.
    supabaseRaw.from('re_subscriptions').select('monthly_amount, started_at, ended_at'),
  ]);
  if (activeErr) throw activeErr;
  if (endedErr) throw endedErr;
  if (startErr) throw startErr;
  if (allErr) throw allErr;

  const activeRows = active || [];
  const mrr = round2(activeRows.reduce((sum, r) => sum + Number(r.monthly_amount || 0), 0));
  const payingCustomers = activeRows.length;
  const mrrStartOfMonth = round2((activeStartOfMonth || []).reduce((sum, r) => sum + Number(r.monthly_amount || 0), 0));
  const activeCountStartOfMonth = (activeStartOfMonth || []).length;

  const mrrByPlan = {};
  for (const row of activeRows) {
    mrrByPlan[row.plan] = round2((mrrByPlan[row.plan] || 0) + Number(row.monthly_amount || 0));
  }

  // 12-month MRR trend. A subscription counts toward a given month if it
  // was active at ANY point during that month — started on or before the
  // month's last day, and either still active or ended after the month's
  // first day.
  const now = new Date();
  const monthlyMrr = [];
  for (let i = 11; i >= 0; i -= 1) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStart = monthDate.toISOString();
    const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1).toISOString();
    const monthMrr = (allSubs || [])
      .filter((r) => r.started_at < monthEnd && (!r.ended_at || r.ended_at > monthStart))
      .reduce((sum, r) => sum + Number(r.monthly_amount || 0), 0);
    monthlyMrr.push({ month: monthStart.slice(0, 7), mrr: round2(monthMrr) });
  }

  return {
    mrr,
    total_paying_customers: payingCustomers,
    average_revenue_per_customer: payingCustomers ? round2(mrr / payingCustomers) : 0,
    // Subscriptions ended this month ÷ subscriptions active as of the start
    // of this month — the spec's own formula, verbatim.
    churn_rate: activeCountStartOfMonth
      ? round2(((endedThisMonth || []).length / activeCountStartOfMonth) * 100)
      : 0,
    // AUDIT FIX (AD8) — null, not 0, when there was no MRR at the start of
    // this month (the platform's first month, or any month it happened to
    // start with zero paying customers) — 0 reads as "flat, no growth from
    // a real baseline", which is a different, false claim from "there is no
    // baseline to compare against yet". The frontend shows "First month" for
    // null rather than a misleading "+0%"/"0%".
    monthly_growth_rate: mrrStartOfMonth
      ? round2(((mrr - mrrStartOfMonth) / mrrStartOfMonth) * 100)
      : null,
    mrr_by_plan: mrrByPlan,
    monthly_mrr_last_12: monthlyMrr,
  };
}

// ── SECTION 22 — feature usage across every workspace ───────────────────────
// re_feature_events (migrations/053) is one row per (org, feature, day),
// written by featureUsageService.track() from ten call sites across the
// product. This is the only reader — everything here is aggregation, no
// write.
async function featureUsage() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: rows, error } = await supabaseRaw
    .from('re_feature_events')
    .select('organization_id, feature, count')
    .gte('date', since);
  if (error) throw error;

  const byFeature = {};
  const byOrg = new Map();
  for (const row of rows || []) {
    byFeature[row.feature] = (byFeature[row.feature] || 0) + row.count;
    if (!byOrg.has(row.organization_id)) byOrg.set(row.organization_id, {});
    const orgFeatures = byOrg.get(row.organization_id);
    orgFeatures[row.feature] = (orgFeatures[row.feature] || 0) + row.count;
  }

  const orgIds = [...byOrg.keys()];
  const [{ data: teams }, { data: users }] = await Promise.all([
    orgIds.length ? supabaseRaw.from('teams').select('id, name').in('id', orgIds) : Promise.resolve({ data: [] }),
    orgIds.length ? supabaseRaw.from('users').select('id, full_name, email').in('id', orgIds) : Promise.resolve({ data: [] }),
  ]);
  const teamById = new Map((teams || []).map((t) => [t.id, t.name]));
  const userById = new Map((users || []).map((u) => [u.id, u.full_name || u.email]));

  // Solo workspaces (no teams row) have their own id as organization_id —
  // same fallback listWorkspaces above already relies on.
  const workspaces = orgIds
    .map((orgId) => {
      const features = byOrg.get(orgId);
      const total = Object.values(features).reduce((sum, n) => sum + n, 0);
      return {
        organization_id: orgId,
        name: teamById.get(orgId) || userById.get(orgId) || orgId,
        features,
        total,
      };
    })
    .sort((a, b) => b.total - a.total);

  return {
    since,
    features: featureUsageService.FEATURES,
    by_feature: byFeature,
    workspaces,
  };
}

module.exports = {
  overview,
  listWorkspaces,
  listUsers,
  resetUserPassword,
  hardDeleteUser,
  impersonateWorkspace,
  sendTestBrief,
  resetBriefCache,
  agentActionsLog,
  notificationStats,
  health,
  migrationStatus,
  revenue,
  featureUsage,
  version,
  MIN_PASSWORD_LENGTH,
  badRequest,
  notFound,
};
