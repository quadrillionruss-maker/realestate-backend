// portalNotificationService.js — the buyer portal's own notification bell,
// SECTION 20.
//
// Five triggers, one entry point (notify below): a payment recorded, a
// document generated, a developer posting in the buyer's project
// community, a hardship request decided, or staff replying to a message.
// Never throws — the same rule pushService.js's staff-side equivalent
// follows: a notification failing to log must never fail the event that
// triggered it (a payment is already in the database by the time this runs).

const { supabaseAdmin } = require('../middleware/orgContext');

async function notify(orgId, customerId, type, title, body = null) {
  try {
    const { error } = await supabaseAdmin.from('re_portal_notifications').insert({
      organization_id: orgId,
      customer_id: customerId,
      type,
      title: String(title).slice(0, 100),
      body,
    });
    if (error) throw error;
  } catch (err) {
    console.warn('[portal-notifications] could not record notification:', err.message);
  }
}

// GET /portal/notifications/:reservationId reads by CUSTOMER, not
// reservation — the route just uses the reservation to prove the caller
// owns something in this org (assertOwnsReservation), the same way several
// other portal routes use one reservation id to stand in for "this is
// genuinely this buyer" without every table underneath needing its own
// reservation scope.
async function listForCustomer(orgId, customerId, { limit = 20 } = {}) {
  const [{ data: items, error }, { count: unreadCount, error: countError }] = await Promise.all([
    supabaseAdmin
      .from('re_portal_notifications')
      .select('id, type, title, body, created_at, read_at')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(limit, 100))),
    supabaseAdmin
      .from('re_portal_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .is('read_at', null),
  ]);
  if (error) throw error;
  if (countError) throw countError;
  return { items: items || [], unread_count: unreadCount || 0 };
}

async function markRead(orgId, customerId, notificationId) {
  await supabaseAdmin
    .from('re_portal_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .eq('id', notificationId)
    .is('read_at', null);
}

module.exports = { notify, listForCustomer, markRead };
