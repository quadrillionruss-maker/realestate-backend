// routes/settings.js — the workspace's own record of itself: letterhead,
// commission default, who gets told what, and who else is in here.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const { audit } = require('../services/auditService');
const auth = require('../services/authService');
const invites = require('../services/inviteService');
const { ROLE_LABELS, INVITABLE_ROLES, canInviteRole } = require('../services/permissions');
const { uploadTeamLogo } = require('../services/documentStorage');
const { encrypt, last4 } = require('../utils/credentials');
const { verifyPaystackKey } = require('../services/paystackService');
const { sendTestEmail } = require('../services/notificationService');
const router = express.Router();

const SETTINGS_COLUMNS = `organization_id, company_name, logo_url, address, phone, website,
  default_commission_rate, notify_md_email, notify_on_payment, notify_on_overdue,
  notify_payment_reminders, reply_to_email, updated_at,
  paystack_public_key, paystack_secret_key_last4,
  resend_from_email, resend_api_key_last4`;

// A logo is a handful of uploads a year, not traffic — this just keeps one
// account from hammering Storage.
const logoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  message: { error: 'Too many uploads. Wait a few minutes and try again.' },
});

// Every table this service owns carries organization_id. Converting a solo
// workspace into a team changes what that id IS, so all of them have to move
// together — see the team block below.
const ORG_SCOPED_TABLES = [
  're_projects', 're_units', 're_customers', 're_sales_reps', 're_reservations',
  're_installment_plans', 're_installment_schedule', 're_payments', 're_documents',
  're_tasks', 're_ai_briefs', 're_commissions', 're_payment_promises',
  're_audit_log', 're_notifications',
];

router.get('/', requirePermission('settings.read'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_org_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (error) throw error;

    // A workspace that has never opened this screen has no row. Return the
    // defaults rather than null, so the form has something to render.
    const settings = data || {
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
      paystack_public_key: null,
      paystack_secret_key_last4: null,
      resend_from_email: null,
      resend_api_key_last4: null,
    };

    // A team's logo upload (POST /logo below) writes to teams.logo_url, not
    // this row, so a team that has only ever used the upload widget would
    // otherwise read back no logo at all here. Merge for the response only —
    // never write it back — and this row wins whenever it is actually set,
    // since it's the field PUT / edits directly and the one brandingService
    // already treats as authoritative for a workspace's letterhead.
    if (!settings.logo_url && req.user.team_id) {
      const { data: team } = await supabaseAdmin
        .from('teams').select('logo_url').eq('id', req.orgId).maybeSingle();
      if (team?.logo_url) settings.logo_url = team.logo_url;
    }

    // The encrypted columns are never selected in the first place (see
    // SETTINGS_COLUMNS) — *_last4 plus this boolean is the entire vocabulary
    // the frontend gets for "is a key on file", the same masked-credential
    // convention as paystackService.js and notificationService.js use
    // wherever a secret is read back for display rather than for use.
    settings.paystack_configured = !!settings.paystack_secret_key_last4;
    settings.resend_configured = !!settings.resend_api_key_last4;

    res.json(settings);
  } catch (e) { next(e); }
});

// Owner only. The commission default, the letterhead and who gets alerted are
// the workspace's own identity — a Head of Sales runs the sales book, not the
// company's name on a buyer's allocation letter.
router.put('/', requirePermission('settings.write'), async (req, res, next) => {
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

// Base64 in a JSON body rather than multipart, same tradeoff as unit media
// (routes/units.js): no upload middleware, no new dependency, for a file a
// workspace changes a handful of times a year.
//
// Which row this writes to is decided from req.user.team_id alone — present
// means organization_id is a team's id, absent means it's the caller's own
// (organization_id = user.team_id ?? user.id, CLAUDE.md) — so a solo
// workspace needs no team to exist first, unlike everything else under /team.
// Gated the same as the rest of workspace settings — a logo is the
// workspace's identity, not a sales action.
router.post('/logo', requirePermission('settings.write'), logoLimiter, async (req, res, next) => {
  try {
    const { content, content_type } = req.body || {};
    if (!content || !content_type) {
      return res.status(400).json({ error: 'content (base64) and content_type are required' });
    }

    const base64 = String(content).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'content is not valid base64' });

    const stored = await uploadTeamLogo(req.orgId, buffer, content_type);

    let logoUrl;
    let team = null;
    if (req.user.team_id) {
      const { data, error } = await supabaseAdmin
        .from('teams')
        .update({ logo_url: stored.url })
        .eq('id', req.orgId)
        .select('id, name, owner_id, logo_url, created_at')
        .single();
      if (error) throw error;
      team = data;
      logoUrl = data.logo_url;
    } else {
      const { data, error } = await supabaseAdmin
        .from('re_org_settings')
        .upsert({ organization_id: req.orgId, logo_url: stored.url }, { onConflict: 'organization_id' })
        .select(SETTINGS_COLUMNS)
        .single();
      if (error) throw error;
      logoUrl = data.logo_url;
    }

    audit(req, {
      action: 'team.logo_updated',
      entityType: req.user.team_id ? 'teams' : 're_org_settings',
      entityId: req.orgId,
      summary: 'Workspace logo updated',
      metadata: { path: stored.path },
    });

    res.json({ logo_url: logoUrl, team });
  } catch (e) { next(e); }
});

// ── Per-workspace Paystack ───────────────────────────────────────────────
// Owner only, same tier as PUT / — a Paystack secret key settles buyers'
// money into whichever business it belongs to, which is squarely "money",
// not "workspace identity" but gated no less tightly for it.
//
// paystack_secret_key is accepted as plaintext in the request body (over
// HTTPS, from an authenticated owner) and never stored that way — it is
// encrypted immediately via credentials.js and only the ciphertext and a
// last4 fingerprint are written. Sending an empty string clears it and
// reverts the workspace to the platform's own key; omitting the field
// entirely leaves whatever is already saved untouched.
router.put('/paystack', requirePermission('settings.write'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = { organization_id: req.orgId };

    if (body.paystack_public_key !== undefined) {
      updates.paystack_public_key = body.paystack_public_key || null;
    }

    if (body.paystack_secret_key !== undefined) {
      const key = String(body.paystack_secret_key || '').trim();
      if (key) {
        updates.paystack_secret_key_encrypted = encrypt(key);
        updates.paystack_secret_key_last4 = last4(key);
      } else {
        updates.paystack_secret_key_encrypted = null;
        updates.paystack_secret_key_last4 = null;
      }
    }

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_org_settings')
      .upsert(updates, { onConflict: 'organization_id' })
      .select('paystack_public_key, paystack_secret_key_last4')
      .single();
    if (error) throw error;

    audit(req, {
      action: 'settings.paystack_updated',
      entityType: 're_org_settings',
      summary: body.paystack_secret_key !== undefined
        ? (data.paystack_secret_key_last4
          ? 'Workspace Paystack secret key updated'
          : 'Workspace Paystack secret key cleared — reverted to the platform key')
        : 'Workspace Paystack public key updated',
      metadata: { paystack_configured: !!data.paystack_secret_key_last4 },
    });

    res.json({
      paystack_public_key: data.paystack_public_key,
      paystack_secret_key_last4: data.paystack_secret_key_last4,
      paystack_configured: !!data.paystack_secret_key_last4,
    });
  } catch (e) { next(e); }
});

// The Settings "test these keys" button — tests the CANDIDATE value still
// sitting in the form, not whatever is already saved, so a typo is caught
// before it is committed. No side effects: verifyPaystackKey lists (at most)
// one existing transaction and nothing more.
router.post('/paystack/test', requirePermission('settings.write'), async (req, res, next) => {
  try {
    const secretKey = String(req.body?.secret_key || '').trim();
    res.json(await verifyPaystackKey(secretKey));
  } catch (e) { next(e); }
});

// ── Per-workspace email (Resend) ────────────────────────────────────────
// Same shape and the same owner-only gate as Paystack above. Configuring
// this is entirely optional — every send already works against the
// platform's own Resend account (see notificationService.js); the only
// thing this changes is whose name and domain a buyer sees it come from.
router.put('/email', requirePermission('settings.write'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = { organization_id: req.orgId };

    if (body.resend_from_email !== undefined) {
      updates.resend_from_email = body.resend_from_email || null;
    }

    if (body.resend_api_key !== undefined) {
      const key = String(body.resend_api_key || '').trim();
      if (key) {
        updates.resend_api_key_encrypted = encrypt(key);
        updates.resend_api_key_last4 = last4(key);
      } else {
        updates.resend_api_key_encrypted = null;
        updates.resend_api_key_last4 = null;
      }
    }

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_org_settings')
      .upsert(updates, { onConflict: 'organization_id' })
      .select('resend_from_email, resend_api_key_last4')
      .single();
    if (error) throw error;

    audit(req, {
      action: 'settings.email_updated',
      entityType: 're_org_settings',
      summary: body.resend_api_key !== undefined
        ? (data.resend_api_key_last4
          ? 'Workspace email (Resend) key updated'
          : 'Workspace email key cleared — reverted to the platform default')
        : 'Workspace From-email address updated',
      metadata: { resend_configured: !!data.resend_api_key_last4 },
    });

    res.json({
      resend_from_email: data.resend_from_email,
      resend_api_key_last4: data.resend_api_key_last4,
      resend_configured: !!data.resend_api_key_last4,
    });
  } catch (e) { next(e); }
});

// Sends one real email to the CALLING owner's own address — Resend has no
// no-side-effect validity check the way Paystack's transaction list does, so
// "does this work" and "send a test" are necessarily the same call. Tests the
// candidate form values, not whatever is already saved.
router.post('/email/test', requirePermission('settings.write'), async (req, res, next) => {
  try {
    const apiKey = String(req.body?.resend_api_key || '').trim();
    const from = String(req.body?.resend_from_email || '').trim();
    res.json(await sendTestEmail({ apiKey, from, to: req.user.email }));
  } catch (e) { next(e); }
});

// ── Team ───────────────────────────────────────────────────────────────────

router.get('/team', requirePermission('team.read'), async (req, res, next) => {
  try {
    // A solo workspace has organization_id === the user's own id and no team
    // row. Saying so plainly is more useful than an empty list.
    if (!req.user.team_id) {
      const { data: me } = await supabaseAdmin
        .from('users').select('id, email, full_name, last_login_at').eq('id', req.userId).maybeSingle();
      return res.json({
        is_team: false,
        team: null,
        invitable_roles: [],
        members: me ? [{
          user_id: me.id, email: me.email, full_name: me.full_name,
          role: 'owner', status: 'active', last_login_at: me.last_login_at,
        }] : [],
      });
    }

    const [team, members] = await Promise.all([
      supabaseAdmin.from('teams').select('id, name, owner_id, logo_url, created_at').eq('id', req.orgId).maybeSingle(),
      // last_login_at answers the question an MD actually has about a team —
      // "is my collections officer working today?" — without any of the
      // keystroke-level monitoring that question usually turns into.
      supabaseAdmin.from('team_members')
        .select('id, role, invited_role, invite_expires_at, status, invited_email, joined_at, users(id, email, full_name, last_login_at)')
        .eq('team_id', req.orgId),
    ]);
    if (team.error) throw team.error;
    if (members.error) throw members.error;

    res.json({
      is_team: true,
      team: team.data,
      // Which roles THIS caller may hand out, so the invite form draws the
      // right dropdown rather than offering a Head of Sales to a Head of Sales
      // and letting the API refuse it after they have typed the address.
      invitable_roles: INVITABLE_ROLES
        .filter((role) => canInviteRole(req.orgRole, role))
        .map((role) => ({ role, label: ROLE_LABELS[role] })),
      members: (members.data || []).map((m) => ({
        id: m.id,
        user_id: m.users?.id || null,
        email: m.users?.email || m.invited_email,
        full_name: m.users?.full_name || null,
        role: m.role,
        role_label: ROLE_LABELS[m.role] || m.role,
        // A pending invite's `role` and `invited_role` are the same value; the
        // pair is carried so the UI can say "invited as Collections Officer"
        // for a row that grants nothing yet.
        invited_role: m.invited_role || null,
        invite_expires_at: m.invite_expires_at || null,
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

    // A solo workspace's logo lives in re_org_settings, keyed by the id that
    // is about to stop being the org id at all. Carrying it straight onto the
    // new team's own logo_url means the conversion doesn't read as "the logo
    // disappeared" — GET / falls back to this column whenever
    // re_org_settings.logo_url (unset on the fresh row below) is empty.
    const { data: soloSettings } = await supabaseAdmin
      .from('re_org_settings').select('logo_url').eq('organization_id', req.orgId).maybeSingle();

    const { data: team, error: teamErr } = await supabaseAdmin
      .from('teams')
      .insert({ name, owner_id: req.userId, logo_url: soloSettings?.logo_url || null })
      .select()
      .single();
    if (teamErr) throw teamErr;

    const { error: memberErr } = await supabaseAdmin
      .from('team_members')
      .insert({ team_id: team.id, user_id: req.userId, role: 'owner', status: 'active' });
    if (memberErr) {
      // A hard delete, not a soft one — this team row is seconds old, has no
      // member and nothing points at it yet (the org-scoped move below
      // hasn't run), so there's nothing for softDelete.js's cascade to
      // protect. Audited anyway, so this rollback isn't the one hard delete
      // in the product with no trace.
      await supabaseAdmin.from('teams').delete().eq('id', team.id);
      audit(req, {
        action: 'team.rollback',
        entityType: 'teams',
        entityId: team.id,
        summary: `Team "${name}" rolled back — membership creation failed: ${memberErr.message}`,
        metadata: { name, reason: memberErr.message },
      });
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

    // No new token to issue: it carries no org scope of its own (id, email
    // and tv only — see authService.issueToken) and org scope is resolved
    // fresh from team_members on every request, not cached in the token. The
    // team_members row above already exists by the time this responds, so
    // the caller's EXISTING token already resolves to the new team id on its
    // very next use. What does go stale is the frontend's own cached
    // /auth/me snapshot — its job to refetch, not this endpoint's.
    res.status(201).json({ team, moved, failed });
  } catch (e) { next(e); }
});

// Invite by email. The invited row is 'invited', not 'active', so it grants
// nothing until they accept — src/middleware/auth.js only counts active
// membership when resolving the org scope.
//
// The rules that make this more than an insert live in
// src/services/inviteService.js: a seven-day signed link, the role it was
// issued for, and the ten-workspace cap. Which roles the CALLER may hand out
// is permissions.canInviteRole — an owner can appoint a Head of Sales, a Head
// of Sales can build their own team but cannot appoint a second one.
router.post('/team/invite', requirePermission('team.invite'), async (req, res, next) => {
  try {
    if (!req.user.team_id) {
      return res.status(409).json({ error: 'Create a team first, then invite people to it.' });
    }

    const email = auth.normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'email is required' });

    const { data: team } = await supabaseAdmin
      .from('teams').select('name').eq('id', req.orgId).maybeSingle();

    const result = await invites.createInvite({
      orgId: req.orgId,
      inviterRole: req.orgRole,
      inviterUserId: req.userId,
      email,
      role: req.body?.role || 'sales_rep',
      teamName: team?.name || null,
    });

    audit(req, {
      action: 'team.invited',
      entityType: 'team_members',
      entityId: result.member.id,
      summary: `Invited ${email} as ${ROLE_LABELS[result.invited_role] || result.invited_role}`
        + (result.joined_immediately ? ' — they already had an account and joined immediately' : ''),
      metadata: {
        email,
        role: result.invited_role,
        existing_account: result.joined_immediately,
        emailed: result.emailed,
        expires_at: result.expires_at,
      },
    });

    res.status(201).json(result);
  } catch (e) { next(e); }
});

// What is this person actually holding? Called before the removal is
// confirmed, so the modal can say "Emeka has 40 open reservations — reassign
// them to:" instead of removing him and leaving forty buyers with nobody
// chasing them, no commission accruing, and the morning brief naming a rep who
// no longer exists.
router.get('/team/:id/workload', requirePermission('team.workload'), async (req, res, next) => {
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
    //
    // Matched on user_id, not on the email address this used to compare. An
    // email is a mutable label: somebody who changes theirs would read as a
    // different person here, keep their reservations and lose their identity —
    // and worse, could inherit the rep record of whoever the old address was
    // later reassigned to.
    const { data: reps } = await supabaseAdmin
      .from('re_sales_reps')
      .select('id, user_id, active, commission_rate, users(full_name, email)')
      .eq('organization_id', req.orgId);

    const theirs = (reps || []).filter((r) => r.user_id && r.user_id === member.user_id);
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

// The owner can never be removed or demoted through PATCH /team/:id below —
// deliberately, so a workspace can't end up with nobody able to administer
// it. This is the one sanctioned way ownership actually moves: it promotes a
// target member and demotes the caller in the same request, rather than
// leaving "the owner left the company" with no route through the product at
// all. Owner-only — a Head of Sales can manage members, but handing off the
// workspace itself is the current owner's call alone.
router.post('/team/transfer-owner', requirePermission('settings.transferOwner'), async (req, res, next) => {
  try {
    const { member_id } = req.body || {};
    if (!member_id) return res.status(400).json({ error: 'member_id is required' });

    const { data: target } = await supabaseAdmin
      .from('team_members')
      .select('id, user_id, role, status, users(full_name, email)')
      .eq('id', member_id)
      .eq('team_id', req.orgId)
      .maybeSingle();
    if (!target) return res.status(404).json({ error: 'Team member not found' });
    if (target.status !== 'active') {
      return res.status(409).json({ error: 'Only an active team member can become the owner.' });
    }
    if (target.role === 'owner') {
      return res.status(409).json({ error: 'This person is already the owner.' });
    }

    const { data: caller } = await supabaseAdmin
      .from('team_members')
      .select('id')
      .eq('team_id', req.orgId)
      .eq('user_id', req.userId)
      .eq('role', 'owner')
      .maybeSingle();
    if (!caller) return res.status(404).json({ error: 'Your own membership record could not be found.' });

    // Promote first: Supabase's REST client has no cross-row transaction, so
    // a failure between the two writes should fail toward two owners rather
    // than zero — recoverable, unlike a workspace nobody can administer.
    const { error: promoteErr } = await supabaseAdmin
      .from('team_members')
      .update({ role: 'owner' })
      .eq('id', target.id)
      .eq('team_id', req.orgId);
    if (promoteErr) throw promoteErr;

    // The outgoing owner becomes Head of Sales — the closest thing to what
    // 'admin' meant before this role model existed, and the only role that
    // still sees the whole sales book.
    const { error: demoteErr } = await supabaseAdmin
      .from('team_members')
      .update({ role: 'sales_director' })
      .eq('id', caller.id)
      .eq('team_id', req.orgId);
    if (demoteErr) throw demoteErr;

    audit(req, {
      action: 'team.owner_transferred',
      entityType: 'team_members',
      entityId: target.id,
      summary: `Ownership transferred to ${target.users?.full_name || target.users?.email || 'another member'}`,
      metadata: { from_user_id: req.userId, to_member_id: target.id, to_user_id: target.user_id },
    });

    res.json({ transferred: true });
  } catch (e) { next(e); }
});

// Changing somebody's role after they have joined, or removing them. The same
// tier that can invite can re-role, and the same restriction applies: only the
// owner can make somebody a Head of Sales, because that is the role that then
// sees the entire book.
router.patch('/team/:id', requirePermission('team.manageMembers'), async (req, res, next) => {
  try {
    const updates = {};
    if (req.body?.role) {
      if (!INVITABLE_ROLES.includes(req.body.role)) {
        return res.status(400).json({ error: `role must be one of: ${INVITABLE_ROLES.join(', ')}` });
      }
      if (!canInviteRole(req.orgRole, req.body.role)) {
        return res.status(403).json({
          error: req.body.role === 'sales_director'
            ? 'Only the workspace owner can make somebody a Head of Sales.'
            : `${ROLE_LABELS[req.orgRole] || 'This role'} cannot assign that role.`,
        });
      }
      updates.role = req.body.role;
      // A pending invite that is re-roled before it is accepted has to carry
      // the new role, or accepting it would quietly restore the old one.
      updates.invited_role = req.body.role;
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

  // By user_id, for the same reason the workload endpoint above is: an email
  // is a label somebody can change, and a departing rep's forty buyers must
  // not hinge on whether they ever updated their address.
  const { data: reps } = await supabaseAdmin
    .from('re_sales_reps')
    .select('id, user_id')
    .eq('organization_id', req.orgId);

  const theirRepIds = (reps || [])
    .filter((r) => r.user_id && r.user_id === member.user_id)
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
