// pushService.js — browser push + the topbar bell (SECTION 1).
//
// Two independent things happen on every notify() call:
//   1. IN-APP (the bell) — one re_push_notifications row per targeted user,
//      always written, regardless of whether they have ever granted
//      browser push permission. This is what GET /push/notifications reads.
//   2. BROWSER PUSH (via web-push) — only to whichever of those users
//      actually hold a live subscription, and only if VAPID is configured.
//      A dead subscription (404/410 — uninstalled, permission revoked,
//      browser data cleared) is dropped here, not retried.
//
// Same rules notificationService.js already follows for email/SMS: never
// throws (a notification failing must never fail the event that triggered
// it), and an unconfigured provider degrades silently rather than erroring.

const webpush = require('web-push');
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');

let vapidConfigured = false;
if (env.vapid.publicKey && env.vapid.privateKey) {
  webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
  vapidConfigured = true;
}

function configured() {
  return vapidConfigured;
}

async function subscribe(userId, orgId, subscription) {
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw Object.assign(new Error('A valid PushSubscription (endpoint, keys.p256dh, keys.auth) is required.'), { statusCode: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('re_push_subscriptions')
    .upsert(
      { user_id: userId, organization_id: orgId, endpoint, p256dh, auth },
      { onConflict: 'endpoint' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function unsubscribe(orgId, endpoint) {
  if (!endpoint) return;
  await supabaseAdmin
    .from('re_push_subscriptions')
    .delete()
    .eq('organization_id', orgId)
    .eq('endpoint', endpoint);
}

// Team accounts read from team_members; a solo account has no such row at
// all and IS its own owner (organization_id = user.team_id ?? user.id, the
// same fold every other part of this product uses) — so "owner" resolves
// to orgId itself and every other role resolves to nobody, since a solo
// workspace has no separate collections officer.
async function resolveUserIdsByRole(orgId, roles) {
  const { data: teamRows } = await supabaseAdmin
    .from('team_members')
    .select('user_id, role')
    .eq('team_id', orgId)
    .eq('status', 'active');

  if (teamRows && teamRows.length) {
    return teamRows.filter((r) => roles.includes(r.role)).map((r) => r.user_id);
  }
  return roles.includes('owner') ? [orgId] : [];
}

async function sendBrowserPush(orgId, userIds, payload) {
  if (!configured() || !userIds.length) return { sent: 0 };

  try {
    const { data: subs, error } = await supabaseAdmin
      .from('re_push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('organization_id', orgId)
      .in('user_id', userIds);
    if (error) throw error;

    let sent = 0;
    for (const sub of subs || []) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
        );
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await supabaseAdmin.from('re_push_subscriptions').delete().eq('id', sub.id);
        } else {
          console.warn('[push] send failed:', err.message);
        }
      }
    }
    return { sent };
  } catch (err) {
    console.warn('[push] could not send:', err.message);
    return { sent: 0 };
  }
}

// The one entry point every trigger (payment recorded, brief generated, new
// overdue buyer, hardship request submitted) calls. `payload` is
// { title, body, url }.
async function notify(orgId, userIds, payload) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return { logged: 0, pushed: 0 };

  let logged = 0;
  try {
    const { error } = await supabaseAdmin.from('re_push_notifications').insert(
      ids.map((userId) => ({
        user_id: userId,
        organization_id: orgId,
        title: payload.title,
        body: payload.body || null,
        url: payload.url || null,
      }))
    );
    if (error) throw error;
    logged = ids.length;
  } catch (err) {
    console.warn('[push] could not log in-app notification:', err.message);
  }

  const { sent: pushed } = await sendBrowserPush(orgId, ids, payload);
  return { logged, pushed };
}

async function notifyByRole(orgId, roles, payload) {
  const ids = await resolveUserIdsByRole(orgId, roles);
  return notify(orgId, ids, payload);
}

// ── The bell ─────────────────────────────────────────────────────────────
async function listNotifications(orgId, userId, { limit = 20 } = {}) {
  const [{ data: items, error }, { count: unreadCount, error: countError }] = await Promise.all([
    supabaseAdmin
      .from('re_push_notifications')
      .select('id, title, body, url, created_at, read_at')
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(limit, 100))),
    supabaseAdmin
      .from('re_push_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .is('read_at', null),
  ]);
  if (error) throw error;
  if (countError) throw countError;
  return { items: items || [], unread_count: unreadCount || 0 };
}

async function markRead(orgId, userId, notificationId) {
  await supabaseAdmin
    .from('re_push_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('user_id', userId)
    .eq('id', notificationId)
    .is('read_at', null);
}

async function markAllRead(orgId, userId) {
  await supabaseAdmin
    .from('re_push_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('user_id', userId)
    .is('read_at', null);
}

module.exports = {
  configured,
  subscribe,
  unsubscribe,
  resolveUserIdsByRole,
  notify,
  notifyByRole,
  listNotifications,
  markRead,
  markAllRead,
};
