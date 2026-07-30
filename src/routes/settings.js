// routes/settings.js — the workspace's own record of itself: letterhead,
// commission default, who gets told what, and who else is in here.

const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { audit } = require('../services/auditService');
const auth = require('../services/authService');
const router = express.Router();

const SETTINGS_COLUMNS = `organization_id, company_name, logo_url, address, phone, website,
  default_commission_rate, notify_md_email, notify_on_payment, notify_on_overdue,
  notify_payment_reminders, reply_to_email, updated_at`;

// Every table this service owns carries organization_id. Converting a solo
// workspace into a team changes what that id IS, so all of them have to move
// together — see the team block below.
const ORG_SCOPED_TABLES = [
  're_projects', 're_units', 're_customers', 're_sales_reps', 're_reservations',
  're_installment_plans', 're_installment_schedule', 're_payments', 're_documents',
  're_tasks', 're_ai_briefs', 're_commissions', 're_payment_promises',
  're_audit_log', 're_notifications',
];

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_org_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (error) throw error;

    // A workspace that has never opened this screen has no row. Return the
    // defaults rather than null, so the form has something to render.
    res.json(data || {
      organization_id: req.orgId,
      company_name: null,
      logo_url: null,
      address: null,
      phone: null,
      website: null,
      default_commission_rate: 0,
      notify_md_email: null,
      notify_on_payment: true,
      notify_on_overdue: true,
      notify_payment_reminders: false,
      reply_to_email: null,
    });
  } catch (e) { next(e); }
});

router.put('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = { organization_id: req.orgId };

    for (const field of ['company_name', 'logo_url', 'address', 'phone', 'website',
      'notify_md_email', 'reply_to_email']) {
      if (body[field] !== undefined) updates[field] = body[field] || null;
    }
    for (const field of ['notify_on_payment', 'notify_on_overdue', 'notify_payment_reminders']) {
      if (body[field] !== undefined) updates[field] = Boolean(body[field]);
    }

    if (body.default_commission_rate !== undefined) {
      const rate = Number(body.default_commission_rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        return res.status(400).json({ error: 'default_commission_rate must be between 0 and 100' });
      }
      updates.default_commission_rate = rate;
    }

    // A logo is embedded in a Puppeteer-rendered PDF. file: and data: URLs
    // there are a way to pull local content into a customer-facing document,
    // so the check lives at the door rather than in the renderer.
    if (updates.logo_url && !String(updates.logo_url).startsWith('https://')) {
      return res.status(400).json({ error: 'logo_url must be an https:// URL' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_org_settings')
      .upsert(updates, { onConflict: 'organization_id' })
      .select(SETTINGS_COLUMNS)
      .single();
    if (error) throw error;

    audit(req, {
      action: 'settings.updated',
      entityType: 're_org_settings',
      summary: 'Workspace settings updated',
      metadata: { fields: Object.keys(updates).filter((k) => k !== 'organization_id') },
    });

    res.json(data);
  } catch (e) { next(e); }
});

// ── Team ───────────────────────────────────────────────────────────────────

router.get('/team', async (req, res, next) => {
  try {
    // A solo workspace has organization_id === the user's own id and no team
    // row. Saying so plainly is more useful than an empty list.
    if (!req.user.team_id) {
      const { data: me } = await supabaseAdmin
        .from('users').select('id, email, full_name, last_login_at').eq('id', req.userId).maybeSingle();
      return res.json({
        is_team: false,
        team: null,
        members: me ? [{
          user_id: me.id, email: me.email, full_name: me.full_name,
          role: 'owner', status: 'active', last_login_at: me.last_login_at,
        }] : [],
      });
    }

    const [team, members] = await Promise.all([
      supabaseAdmin.from('teams').select('id, name, owner_id, created_at').eq('id', req.orgId).maybeSingle(),
      // last_login_at answers the question an MD actually has about a team —
      // "is my collections officer working today?" — without any of the
      // keystroke-level monitoring that question usually turns into.
      supabaseAdmin.from('team_members')
        .select('id, role, status, invited_email, joined_at, users(id, email, full_name, last_login_at)')
        .eq('team_id', req.orgId),
    ]);
    if (team.error) throw team.error;
    if (members.error) throw members.error;

    res.json({
      is_team: true,
      team: team.data,
      members: (members.data || []).map((m) => ({
        id: m.id,
        user_id: m.users?.id || null,
        email: m.users?.email || m.invited_email,
        full_name: m.users?.full_name || null,
        role: m.role,
        status: m.status,
        joined_at: m.joined_at,
        last_login_at: m.users?.last_login_at || null,
      })),
    });
  } catch (e) { next(e); }
});

// Turning a solo workspace into a team.
//
// THIS MOVES EVERY ROW. organization_id is the user's id for a solo account
// and the team's id for a team one, so creating the team without rewriting the
// existing rows would leave every project, buyer and payment addressed to an
// org nobody is a member of any more — the data would still be there and the
// dashboard would be empty. docs/DATABASE.md calls this the backfill.
//
// Supabase's REST client has no cross-table transaction, so this is
// best-effort sequential: the team is created last-to-be-relied-on, each table
// is moved in turn, and the per-table counts are returned so a partial move is
// visible rather than silent.
router.post('/team', async (req, res, next) => {
  try {
    if (req.user.team_id) {
      return res.status(409).json({ error: 'This workspace is already a team.' });
    }

    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { data: team, error: teamErr } = await supabaseAdmin
      .from('teams')
      .insert({ name, owner_id: req.userId })
      .select()
      .single();
    if (teamErr) throw teamErr;

    const { error: memberErr } = await supabaseAdmin
      .from('team_members')
      .insert({ team_id: team.id, user_id: req.userId, role: 'owner', status: 'active' });
    if (memberErr) {
      await supabaseAdmin.from('teams').delete().eq('id', team.id);
      throw memberErr;
    }

    const moved = {};
    const failed = [];
    for (const table of ORG_SCOPED_TABLES) {
      const { data, error } = await supabaseAdmin
        .from(table)
        .update({ organization_id: team.id })
        .eq('organization_id', req.orgId)
        .select('id');
      if (error) { failed.push({ table, error: error.message }); continue; }
      moved[table] = data?.length || 0;
    }

    await supabaseAdmin
      .from('re_org_settings')
      .upsert({ organization_id: team.id, company_name: name }, { onConflict: 'organization_id' });

    audit({ orgId: team.id, userId: req.userId, user: req.user, headers: req.headers, ip: req.ip }, {
      action: 'team.created',
      entityType: 'teams',
      entityId: team.id,
      summary: `Solo workspace converted to team "${name}"`,
      metadata: { moved, failed, previous_organization_id: req.orgId },
    });

    res.status(201).json({
      team,
      moved,
      failed,
      // The caller's existing token still resolves to the OLD org id, because
      // team membership is read at authentication time. Say so — otherwise the
      // screen looks empty and the user assumes the conversion ate their data.
      note: 'Sign out and back in to pick up the new team scope.',
    });
  } catch (e) { next(e); }
});

// Invite by email. The invited row is 'invited', not 'active', so it grants
// nothing until they accept — src/middleware/auth.js only counts active
// membership when resolving the org scope.
router.post('/team/invite', async (req, res, next) => {
  try {
    if (!req.user.team_id) {
      return res.status(409).json({ error: 'Create a team first, then invite people to it.' });
    }
    if (!['owner', 'admin'].includes(req.orgRole)) {
      return res.status(403).json({ error: 'Only an owner or admin can invite team members.' });
    }

    const email = auth.normalizeEmail(req.body?.email);
    const role = req.body?.role || 'member';
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: 'role must be admin or member' });
    }

    // If they already have an account, link it. If not, the invite is held
    // against the address until they register with it.
    const existing = await auth.findUserByEmail(email);

    const { data, error } = await supabaseAdmin
      .from('team_members')
      .upsert({
        team_id: req.orgId,
        user_id: existing?.id || null,
        invited_email: email,
        role,
        status: existing ? 'active' : 'invited',
      }, { onConflict: 'team_id,user_id' })
      .select()
      .single();
    if (error) throw error;

    audit(req, {
      action: 'team.invited',
      entityType: 'team_members',
      entityId: data.id,
      summary: `Invited ${email} as ${role}`,
      metadata: { email, role, existing_account: Boolean(existing) },
    });

    res.status(201).json(data);
  } catch (e) { next(e); }
});

// What is this person actually holding? Called before the removal is
// confirmed, so the modal can say "Emeka has 40 open reservations — reassign
// them to:" instead of removing him and leaving forty buyers with nobody
// chasing them, no commission accruing, and the morning brief naming a rep who
// no longer exists.
router.get('/team/:id/workload', async (req, res, next) => {
  try {
    const { data: member } = await supabaseAdmin
      .from('team_members')
      .select('id, user_id, role, users(full_name, email)')
      .eq('id', req.params.id)
      .eq('team_id', req.orgId)
      .maybeSingle();
    if (!member) return res.status(404).json({ error: 'Team member not found' });

    if (!member.user_id) {
      return res.json({ has_workload: false, reason: 'This invite was never accepted.', reps: [] });
    }

    // A person is a sales rep through re_sales_reps; their reservations hang
    // off that, not off the user id directly.
    const { data: reps } = await supabaseAdmin
      .from('re_sales_reps')
      .select('id, active, commission_rate, users(full_name, email)')
      .eq('organization_id', req.orgId);

    const theirs = (reps || []).filter((r) => r.users && r.id && r.users.email === member.users?.email);
    const repIds = theirs.map((r) => r.id);

    let openReservations = 0;
    let totalReservations = 0;
    let openValue = 0;

    if (repIds.length) {
      const { data: reservations } = await supabaseAdmin
        .from('re_reservations')
        .select('id, status, re_installment_plans(total_amount, original_total_amount)')
        .eq('organization_id', req.orgId)
        .in('sales_rep_id', repIds);

      for (const reservation of reservations || []) {
        totalReservations += 1;
        if (['reserved', 'confirmed'].includes(reservation.status)) {
          openReservations += 1;
          const plans = Array.isArray(reservation.re_installment_plans)
            ? reservation.re_installment_plans
            : [reservation.re_installment_plans].filter(Boolean);
          openValue += Number(plans[0]?.original_total_amount ?? plans[0]?.total_amount ?? 0);
        }
      }
    }

    res.json({
      member: {
        id: member.id,
        name: member.users?.full_name || member.users?.email || 'This person',
        email: member.users?.email || null,
      },
      sales_rep_ids: repIds,
      has_workload: openReservations > 0,
      open_reservations: openReservations,
      total_reservations: totalReservations,
      open_value: Math.round(openValue * 100) / 100,
      // Who the work can go to. The person being removed is excluded, and so is
      // anyone already inactive.
      reps: (reps || [])
        .filter((r) => r.active && !repIds.includes(r.id))
        .map((r) => ({
          id: r.id,
          name: r.users?.full_name || r.users?.email || 'Unnamed rep',
          commission_rate: Number(r.commission_rate || 0),
        })),
    });
  } catch (e) { next(e); }
});

router.patch('/team/:id', async (req, res, next) => {
  try {
    if (!['owner', 'admin'].includes(req.orgRole)) {
      return res.status(403).json({ error: 'Only an owner or admin can change team membership.' });
    }

    const updates = {};
    if (req.body?.role) {
      if (!['admin', 'member'].includes(req.body.role)) {
        return res.status(400).json({ error: 'role must be admin or member' });
      }
      updates.role = req.body.role;
    }
    if (req.body?.status) {
      if (!['active', 'removed'].includes(req.body.status)) {
        return res.status(400).json({ error: 'status must be active or removed' });
      }
      updates.status = req.body.status;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const { data: member } = await supabaseAdmin
      .from('team_members').select('id, user_id, role')
      .eq('id', req.params.id).eq('team_id', req.orgId).maybeSingle();
    if (!member) return res.status(404).json({ error: 'Team member not found' });

    // Removing the owner leaves a workspace nobody can administer.
    if (member.role === 'owner' && (updates.status === 'removed' || updates.role)) {
      return res.status(409).json({ error: 'The workspace owner cannot be removed or demoted.' });
    }

    const { data, error } = await supabaseAdmin
      .from('team_members')
      .update(updates)
      .eq('id', req.params.id)
      .eq('team_id', req.orgId)
      .select()
      .single();
    if (error) throw error;

    // Removal has to take effect NOW. Team membership is read at authentication
    // time, so a removed member's existing token still resolves to this
    // workspace until it expires — up to 30 days of buyer lists, payment
    // histories and allocation letters, for somebody who left on Monday.
    // Bumping their token_version invalidates every token they hold.
    let sessionsEnded = false;
    let reassigned = null;

    if (updates.status === 'removed' && member.user_id) {
      const version = await auth.bumpTokenVersion(member.user_id);
      sessionsEnded = version !== null;

      // ── Hand over the work ────────────────────────────────────────────────
      // Without this, a departing rep's reservations keep pointing at a rep who
      // is gone: nobody is responsible, nobody is chasing, no commission
      // accrues, and the morning brief names them anyway. The client sends
      // reassign_to after the workload endpoint has told it what is at stake.
      reassigned = await reassignWork(req, member, req.body?.reassign_to || null);
    }

    audit(req, {
      action: 'team.member_updated',
      entityType: 'team_members',
      entityId: data.id,
      summary: `Team member updated: ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')}`
        + (sessionsEnded ? ' — their existing sessions were ended' : '')
        + (reassigned?.moved ? `; ${reassigned.moved} reservation(s) reassigned` : ''),
      metadata: { ...updates, sessions_ended: sessionsEnded, reassigned },
    });

    res.json({ ...data, sessions_ended: sessionsEnded, reassigned });
  } catch (e) { next(e); }
});

// Moves a departing rep's OPEN reservations to another rep, and deactivates
// their rep record.
//
// Only open ones move. A completed or cancelled reservation is history and
// should keep the name of the person who actually sold it — reassigning those
// would rewrite who earned what.
//
// Commission already accrued does NOT move either. It was earned on payments
// that had already landed, at the rate in force then; moving it would take money
// from someone who has left and give it to someone who did not do the work.
// Future payments accrue to the new rep, which is the whole point.
async function reassignWork(req, member, targetRepId) {
  const summary = { moved: 0, deactivated: 0, target: targetRepId || null, orphaned: 0 };

  const { data: reps } = await supabaseAdmin
    .from('re_sales_reps')
    .select('id, users(email)')
    .eq('organization_id', req.orgId);

  const theirRepIds = (reps || [])
    .filter((r) => r.users?.email && r.users.email === member.users?.email)
    .map((r) => r.id);

  if (!theirRepIds.length) return summary;

  if (targetRepId) {
    // The target has to be a live rep in THIS workspace, or a mistyped id would
    // move forty buyers somewhere unreachable.
    const { data: target } = await supabaseAdmin
      .from('re_sales_reps')
      .select('id, active')
      .eq('id', targetRepId)
      .eq('organization_id', req.orgId)
      .maybeSingle();

    if (!target || !target.active) {
      throw Object.assign(
        new Error('Reassign to an active sales rep in this workspace.'),
        { statusCode: 400 }
      );
    }

    const { data: moved, error } = await supabaseAdmin
      .from('re_reservations')
      .update({ sales_rep_id: targetRepId })
      .eq('organization_id', req.orgId)
      .in('sales_rep_id', theirRepIds)
      .in('status', ['reserved', 'confirmed'])
      .select('id');
    if (error) throw error;

    summary.moved = moved?.length || 0;
  } else {
    // No target given: the reservations stay unassigned, which is a legitimate
    // choice ("the MD will handle these"). It is counted and audited so it is a
    // decision on the record rather than an oversight.
    const { data: orphaned } = await supabaseAdmin
      .from('re_reservations')
      .select('id')
      .eq('organization_id', req.orgId)
      .in('sales_rep_id', theirRepIds)
      .in('status', ['reserved', 'confirmed']);
    summary.orphaned = orphaned?.length || 0;
  }

  // Deactivated, never deleted: reservations reference the rep, and who sold
  // what has to stay true after somebody leaves.
  const { data: deactivated } = await supabaseAdmin
    .from('re_sales_reps')
    .update({ active: false })
    .in('id', theirRepIds)
    .eq('organization_id', req.orgId)
    .select('id');

  summary.deactivated = deactivated?.length || 0;
  return summary;
}

module.exports = router;
