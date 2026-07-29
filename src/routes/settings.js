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
        .from('users').select('id, email, full_name').eq('id', req.userId).maybeSingle();
      return res.json({
        is_team: false,
        team: null,
        members: me ? [{ user_id: me.id, email: me.email, full_name: me.full_name, role: 'owner', status: 'active' }] : [],
      });
    }

    const [team, members] = await Promise.all([
      supabaseAdmin.from('teams').select('id, name, owner_id, created_at').eq('id', req.orgId).maybeSingle(),
      supabaseAdmin.from('team_members')
        .select('id, role, status, invited_email, joined_at, users(id, email, full_name)')
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

    audit(req, {
      action: 'team.member_updated',
      entityType: 'team_members',
      entityId: data.id,
      summary: `Team member updated: ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    });

    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
