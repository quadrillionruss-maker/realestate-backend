// inviteService.js — bringing somebody into a workspace, and the rules that
// stop that from being a way in.
//
// The old flow was one upsert: type an address, get a row. It had no token, no
// expiry, and no email — an invited person had to be told out of band that
// they had been invited, then register with exactly the right address and hope.
//
// This one issues a signed-in-a-link invitation that expires in seven days,
// records the role it was issued for, and refuses to make anybody a member of
// an eleventh workspace.
//
// ── ON THE TOKEN ───────────────────────────────────────────────────────────
// An opaque 32-byte random value, stored as-is. Not a JWT: a JWT would be
// self-validating and therefore impossible to revoke by deleting the row, and
// revoking an invite by withdrawing it is exactly what an owner expects
// "cancel invite" to mean. Not hashed either, and that is a deliberate match
// to how this codebase already treats equivalent secrets — re_customers'
// portal access is a signed token checked against a plain version counter, and
// team_members is a service-role-only table behind RLS with no policies. A
// reset token IS hashed (authService.hashResetToken) because it grants
// permanent control of an existing account; an invite token grants membership
// of one workspace at one role, expires in a week, and is single-use.

const crypto = require('crypto');
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const notify = require('./notificationService');
const {
  ROLE_LABELS, canInviteRole, INVITABLE_ROLES,
  MAX_WORKSPACES_PER_USER, wouldExceedWorkspaceCap, isDowngrade,
} = require('./permissions');

const INVITE_TTL_DAYS = 7;

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const forbidden = (message) => Object.assign(new Error(message), { statusCode: 403 });

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function inviteUrl(token) {
  return `${env.appUrl || ''}/index.html#/accept-invite?token=${token}`;
}

// How many workspaces this person is already in or already invited to.
//
// Pending invites COUNT. The requirement is "reject the invite to the
// eleventh", which only means anything if an unaccepted invite occupies a
// slot — otherwise eleven invites could all be sent and the eleventh person to
// click would be the one refused, having already been told they were welcome.
//
// Matched by user_id when they have an account and by invited_email when they
// do not, because a not-yet-registered invitee has no id to count by.
async function workspaceCountFor({ userId, email }) {
  const teamIds = new Set();

  if (userId) {
    const { data, error } = await supabaseAdmin
      .from('team_members')
      .select('team_id')
      .eq('user_id', userId)
      .in('status', ['active', 'invited']);
    if (error) throw error;
    for (const row of data || []) teamIds.add(row.team_id);
  }

  if (email) {
    const { data, error } = await supabaseAdmin
      .from('team_members')
      .select('team_id')
      .eq('invited_email', email)
      .in('status', ['active', 'invited']);
    if (error) throw error;
    for (const row of data || []) teamIds.add(row.team_id);
  }

  return teamIds;
}

// ── Send an invite ─────────────────────────────────────────────────────────
// Returns the row plus how the email went, so the UI can say "invited, but we
// could not email them — here is the link" rather than implying delivery that
// did not happen.
async function createInvite({ orgId, inviterRole, inviterUserId, inviterEmail, email, role, teamName }) {
  if (!email) throw badRequest('email is required');

  if (!INVITABLE_ROLES.includes(role)) {
    throw badRequest(`role must be one of: ${INVITABLE_ROLES.join(', ')}`);
  }
  if (!canInviteRole(inviterRole, role)) {
    // Named specifically rather than generically: the one case a director
    // hits is trying to appoint another director, and "only the chairman can"
    // is the actual answer.
    throw forbidden(role === 'sales_director'
      ? 'Only the workspace owner can invite a Head of Sales.'
      : `${ROLE_LABELS[inviterRole] || 'This role'} cannot invite a ${ROLE_LABELS[role] || role}.`);
  }

  // Self-invite at a lower role is how somebody would otherwise demote
  // themselves without another owner's say-so — canInviteRole above already
  // allows an owner to hand out any role including one beneath their own, so
  // this is a second, narrower check specifically for the self-referential
  // case. Checked before the account lookup below: this refusal has nothing
  // to do with whether the address already has an account.
  if (inviterEmail && email.toLowerCase() === inviterEmail.toLowerCase() && isDowngrade(inviterRole, role)) {
    throw forbidden('You cannot invite yourself at a lower role than your current one. '
      + 'To change your own role, ask another owner to do it.');
  }

  const auth = require('./authService');
  const existing = await auth.findUserByEmail(email);

  // ── The ten-workspace cap ────────────────────────────────────────────────
  // Checked BEFORE the row is written. Re-inviting somebody who is already in
  // this workspace must not be refused by their own existing membership, so
  // this workspace is discounted from their total.
  const teamIds = await workspaceCountFor({ userId: existing?.id || null, email });
  teamIds.delete(orgId);
  if (wouldExceedWorkspaceCap(teamIds.size)) {
    throw Object.assign(
      new Error(`${email} already belongs to ${MAX_WORKSPACES_PER_USER} workspaces, which is the maximum. `
        + 'They will need to leave one before joining another.'),
      { statusCode: 409 }
    );
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();

  // Somebody who already has an account joins immediately — there is nothing
  // for them to accept that clicking a link would establish, and making them
  // round-trip through an email to reach a workspace they can already sign
  // into is friction for nothing. Somebody who does not gets a pending row
  // that grants exactly nothing until they register or accept: auth.js counts
  // only 'active' membership.
  //
  // Two different conflict targets because a NULL user_id is never equal to
  // another NULL under a plain unique constraint — see migrations/012.
  const { data, error } = await supabaseAdmin
    .from('team_members')
    .upsert({
      team_id: orgId,
      user_id: existing?.id || null,
      invited_email: email,
      role,
      invited_role: role,
      status: existing ? 'active' : 'invited',
      // The token is kept on a directly-joined member too, so the link in
      // their email still resolves to something that can say "you are already
      // in" rather than "this invite does not exist".
      invite_token: token,
      invite_expires_at: expiresAt,
    }, { onConflict: existing ? 'team_id,user_id' : 'team_id,invited_email' })
    .select()
    .single();
  if (error) throw error;

  const emailed = await sendInviteEmail({
    orgId, to: email, role, token, teamName, joinedDirectly: Boolean(existing),
  });

  return {
    member: data,
    invited_role: role,
    expires_at: expiresAt,
    joined_immediately: Boolean(existing),
    emailed: emailed.status,
    // Only outside production and only when Resend is unconfigured, matching
    // how the reset and verification flows stay testable locally.
    dev_invite_url: env.isDev && !env.resend.apiKey ? inviteUrl(token) : undefined,
  };
}

async function sendInviteEmail({ orgId, to, role, token, teamName, joinedDirectly }) {
  const workspace = teamName || 'a workspace on Archta';
  const label = ROLE_LABELS[role] || role;

  return notify.sendEmail({
    orgId,
    to,
    subject: `You have been added to ${workspace}`,
    html: notify.emailShell({
      heading: `You are in — as ${label}`,
      intro: joinedDirectly
        ? `You have been added to ${workspace} as ${label}. Sign in with this address and it will be there.`
        : `You have been invited to join ${workspace} as ${label}. `
          + `Open the link below to accept — it expires in ${INVITE_TTL_DAYS} days.`,
      ctaLabel: joinedDirectly ? 'Open Archta' : 'Accept the invitation',
      ctaUrl: inviteUrl(token),
      footer: 'If you were not expecting this, ignore it — nothing happens until you open the link.',
    }),
    text: `${joinedDirectly ? 'You have been added to' : 'You have been invited to join'} `
      + `${workspace} as ${label}: ${inviteUrl(token)}`,
    template: 'team_invite',
  }).catch((err) => {
    // The row is already written. An unreachable mail provider must not undo
    // an invite that has, as far as the workspace is concerned, been issued.
    console.warn('[invite] invitation email failed:', err.message);
    return { status: 'failed' };
  });
}

// ── Look an invite up ──────────────────────────────────────────────────────
// Used by the unauthenticated preview screen, so somebody who clicks a link
// while signed out can be shown "Adron Homes invited you as a Sales Executive"
// before being asked to register.
async function findByToken(token) {
  if (!token) return null;

  const { data, error } = await supabaseAdmin
    .from('team_members')
    .select('id, team_id, user_id, role, invited_role, invited_email, status, invite_expires_at, teams(name)')
    .eq('invite_token', token)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function describeInvite(row) {
  if (!row) return { valid: false, reason: 'not_found' };
  const expired = row.invite_expires_at && new Date(row.invite_expires_at) < new Date();

  return {
    valid: !expired && row.status !== 'removed',
    reason: expired ? 'expired' : row.status === 'removed' ? 'withdrawn' : null,
    email: row.invited_email,
    role: row.invited_role || row.role,
    role_label: ROLE_LABELS[row.invited_role || row.role] || null,
    team_name: row.teams?.name || null,
    already_active: row.status === 'active',
    expires_at: row.invite_expires_at,
  };
}

// ── Accept ─────────────────────────────────────────────────────────────────
// Links a real user onto the pending row and flips it live. The email on the
// invite is NOT required to match the accepting account: an invite link is a
// bearer credential, and somebody who forwards theirs to a colleague has made
// a decision the product should not silently override. What it does enforce is
// the cap, because that is a limit on the account rather than on the invite.
async function acceptInvite({ token, userId, userEmail }) {
  const row = await findByToken(token);
  const summary = describeInvite(row);

  if (!row) throw badRequest('That invitation link is not valid. Ask for a new one.');
  if (summary.reason === 'expired') {
    throw badRequest(`That invitation expired on ${String(row.invite_expires_at).slice(0, 10)}. Ask for a new one.`);
  }
  if (summary.reason === 'withdrawn') {
    throw forbidden('That invitation has been withdrawn.');
  }

  // Already theirs: idempotent rather than an error, because the link is in an
  // email somebody will click twice.
  if (row.user_id && row.user_id === userId) {
    await clearToken(row.id);
    return { joined: true, already_member: true, team_id: row.team_id, role: row.role };
  }
  if (row.user_id && row.user_id !== userId) {
    throw forbidden('That invitation has already been accepted by someone else.');
  }

  const teamIds = await workspaceCountFor({ userId, email: userEmail });
  teamIds.delete(row.team_id);
  if (wouldExceedWorkspaceCap(teamIds.size)) {
    throw Object.assign(
      new Error(`You already belong to ${MAX_WORKSPACES_PER_USER} workspaces, which is the maximum. `
        + 'Leave one before joining another.'),
      { statusCode: 409 }
    );
  }

  const role = row.invited_role || row.role;
  const { data, error } = await supabaseAdmin
    .from('team_members')
    .update({
      user_id: userId,
      role,
      status: 'active',
      joined_at: new Date().toISOString(),
      // Single use. The link stops working the moment it has done its job.
      invite_token: null,
      invite_expires_at: null,
    })
    .eq('id', row.id)
    .select('id, team_id, role')
    .single();
  if (error) throw error;

  return { joined: true, already_member: false, team_id: data.team_id, role: data.role };
}

async function clearToken(memberId) {
  await supabaseAdmin
    .from('team_members')
    .update({ invite_token: null, invite_expires_at: null })
    .eq('id', memberId);
}

// ── Registration hook ──────────────────────────────────────────────────────
// Somebody invited before they had an account registers with that address:
// the pending rows waiting on it become real membership in the same request,
// so they land in the workspace rather than in an empty solo one wondering
// where their company went.
//
// Never throws. A failure here means somebody has an account and no team,
// which is recoverable by clicking the link in their email; failing the
// registration would lose the account entirely.
async function claimPendingInvites({ userId, email }) {
  try {
    const { data: pending, error } = await supabaseAdmin
      .from('team_members')
      .select('id, team_id, role, invited_role')
      .eq('invited_email', email)
      .eq('status', 'invited')
      .is('user_id', null);
    if (error) throw error;
    if (!pending?.length) return [];

    // Capped even here: ten is ten however somebody arrived at it. Oldest
    // first, so which invites are honoured is deterministic rather than
    // whichever the database happened to return.
    const claimed = [];
    for (const row of pending.slice(0, MAX_WORKSPACES_PER_USER)) {
      const { error: updateErr } = await supabaseAdmin
        .from('team_members')
        .update({
          user_id: userId,
          role: row.invited_role || row.role,
          status: 'active',
          joined_at: new Date().toISOString(),
          invite_token: null,
          invite_expires_at: null,
        })
        .eq('id', row.id);
      if (updateErr) throw updateErr;
      claimed.push({ team_id: row.team_id, role: row.invited_role || row.role });
    }
    return claimed;
  } catch (err) {
    console.warn('[invite] could not attach pending invites on registration:', err.message);
    return [];
  }
}

module.exports = {
  INVITE_TTL_DAYS,
  createInvite,
  findByToken,
  describeInvite,
  acceptInvite,
  claimPendingInvites,
  workspaceCountFor,
  inviteUrl,
};
