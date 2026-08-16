// messageService.js — the direct message thread between a buyer and their
// developer, SECTION 5.
//
// One thread per BUYER, not per reservation (re_messages.customer_id — a
// buyer holding two units has one conversation, not two). The portal routes
// still take a :reservationId in the URL, same shape as every other portal
// route, and resolve it to the owning customer via
// portalService.assertOwnsReservation before ever touching a message.
const { supabaseAdmin } = require('../middleware/orgContext');
const { audit, auditSystem } = require('./auditService');
const notify = require('./notificationService');
const portalNotifications = require('./portalNotificationService');

async function listForCustomer(orgId, customerId) {
  const { data, error } = await supabaseAdmin
    .from('re_messages')
    .select('id, sender_type, sender_id, message, read_at, created_at, users(full_name, email)')
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function unreadCountForCustomer(orgId, customerId, unreadFrom) {
  const { data, error } = await supabaseAdmin
    .from('re_messages')
    .select('id')
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .eq('sender_type', unreadFrom)
    .is('read_at', null);
  if (error) throw error;
  return data?.length || 0;
}

// The rep whose name goes on "a buyer messaged" — any of this buyer's own
// live reservations that has one, falling back to nobody rather than
// guessing. A message with no rep to hand it to still lands in the thread
// itself, which is the record of last resort.
async function assignedRepUser(orgId, customerId) {
  const { data } = await supabaseAdmin
    .from('re_reservations')
    .select('sales_rep_id, re_sales_reps(user_id, users(id, full_name, email))')
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .not('sales_rep_id', 'is', null)
    .neq('status', 'cancelled')
    .limit(1)
    .maybeSingle();
  return data?.re_sales_reps?.users || null;
}

// ── Buyer sends, from the portal ────────────────────────────────────────
async function sendFromBuyer(customer, message) {
  const trimmed = String(message || '').trim();
  if (!trimmed) throw Object.assign(new Error('message is required'), { statusCode: 400 });

  const { data, error } = await supabaseAdmin
    .from('re_messages')
    .insert({
      organization_id: customer.organization_id,
      customer_id: customer.id,
      sender_type: 'buyer',
      message: trimmed,
    })
    .select()
    .single();
  if (error) throw error;

  auditSystem({
    orgId: customer.organization_id,
    actorKind: 'portal',
    actorEmail: customer.email,
    action: 'message.sent_by_buyer',
    entityType: 're_messages',
    entityId: data.id,
    summary: `${customer.full_name} sent a message from the buyer portal`,
  });

  // Never let a notification failure hide the fact that the message itself
  // was saved — the same "the record is already true, a side effect must
  // not un-true it" rule paymentEvents.js states for payments.
  try {
    const rep = await assignedRepUser(customer.organization_id, customer.id);
    if (rep) {
      await supabaseAdmin.from('re_tasks').insert({
        organization_id: customer.organization_id,
        title: `Buyer sent a message — ${customer.full_name}`,
        notes: trimmed,
        assigned_to: rep.id,
        source: 'ai', // rule-triggered, not the daily brief — same convention referralService.js uses
      });
      if (rep.email) {
        await notify.sendEmail({
          orgId: customer.organization_id,
          to: rep.email,
          subject: `New message from ${customer.full_name}`,
          html: notify.emailShell({
            heading: `${customer.full_name} sent you a message`,
            intro: trimmed,
          }),
          text: `${customer.full_name}: ${trimmed}`,
          template: 'buyer_message',
          relatedType: 're_customers',
          relatedId: customer.id,
        });
      }
    }
  } catch (err) {
    console.warn('[messages] could not notify rep of new buyer message:', err.message);
  }

  return data;
}

// ── Staff replies, from the buyer drawer ─────────────────────────────────
async function sendFromStaff(req, customer, message) {
  const trimmed = String(message || '').trim();
  if (!trimmed) throw Object.assign(new Error('message is required'), { statusCode: 400 });

  const { data, error } = await supabaseAdmin
    .from('re_messages')
    .insert({
      organization_id: req.orgId,
      customer_id: customer.id,
      sender_type: 'staff',
      sender_id: req.userId,
      message: trimmed,
    })
    .select()
    .single();
  if (error) throw error;

  audit(req, {
    action: 'message.sent_by_staff',
    entityType: 're_messages',
    entityId: data.id,
    summary: `Replied to ${customer.full_name}`,
  });

  if (customer.phone) {
    await notify.sendWhatsApp({
      orgId: req.orgId,
      to: customer.phone,
      body: 'Your developer replied to your message — open your portal to read it.',
      template: 'staff_reply',
      relatedType: 're_customers',
      relatedId: customer.id,
    });
  }

  // SECTION 20 — the portal bell, independent of whether WhatsApp is even
  // configured for this workspace (unlike the send above, which only fires
  // when there's a phone on file).
  await portalNotifications.notify(req.orgId, customer.id, 'message_received',
    'New reply from your developer', trimmed.slice(0, 200));

  return data;
}

// Marks every message from the OTHER party as read — called when the buyer
// opens their portal thread (marks staff messages read) and when staff opens
// the drawer's Messages section (marks buyer messages read).
async function markRead(orgId, customerId, readerType) {
  const otherParty = readerType === 'buyer' ? 'staff' : 'buyer';
  await supabaseAdmin
    .from('re_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .eq('sender_type', otherParty)
    .is('read_at', null);
}

module.exports = { listForCustomer, unreadCountForCustomer, sendFromBuyer, sendFromStaff, markRead, assignedRepUser };
