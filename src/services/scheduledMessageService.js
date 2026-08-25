// scheduledMessageService.js — a WhatsApp message a rep asked to go out
// later, SECTION 16.
//
// Two moments: schedule (a plain insert, nothing sends yet) and the hourly
// sweep (checkScheduledMessages, run from jobs/daily.js), which is the only
// thing that ever actually sends one. Between those two moments a message
// can be cancelled (DELETE /scheduled-messages/:id, status → 'cancelled'),
// which the sweep's own query already excludes by only ever looking at
// status='pending'.

const { supabaseAdmin } = require('../middleware/orgContext');
const notify = require('./notificationService');
const { mapWithConcurrency } = require('../utils/concurrency');

const SWEEP_CONCURRENCY = 8;

async function listForCustomer(orgId, customerId) {
  const { data, error } = await supabaseAdmin
    .from('re_scheduled_messages')
    .select('id, message, scheduled_for, sent_at, status, created_at, users:created_by(full_name, email)')
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .order('scheduled_for', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function schedule(orgId, { customerId, message, scheduledFor, createdBy }) {
  const trimmed = String(message || '').trim();
  if (!trimmed) throw badRequest('message is required.');
  if (!scheduledFor || Number.isNaN(Date.parse(scheduledFor))) {
    throw badRequest('scheduled_for must be a valid date/time.');
  }

  const { data: customer } = await supabaseAdmin
    .from('re_customers')
    .select('id')
    .eq('id', customerId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!customer) throw Object.assign(new Error('Customer not found'), { statusCode: 404 });

  const { data, error } = await supabaseAdmin
    .from('re_scheduled_messages')
    .insert({
      organization_id: orgId,
      customer_id: customerId,
      message: trimmed,
      scheduled_for: new Date(scheduledFor).toISOString(),
      created_by: createdBy || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function cancel(orgId, id) {
  const { data, error } = await supabaseAdmin
    .from('re_scheduled_messages')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('organization_id', orgId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('No pending scheduled message with that id'), { statusCode: 404 });
  return data;
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// The hourly sweep. WhatsApp's own 24-hour customer-service-window rule
// (notificationService.sendWhatsApp's own comment) means even a fully
// configured workspace can have a send rejected by the API itself — a
// scheduled message is, by definition, NOT a reply to the buyer's own
// recent activity, so it may fall outside that window regardless of
// configuration. Both "not configured" (status: 'skipped') and "configured
// but WhatsApp refused it" (status: 'failed') land here as the same
// outcome: mark the row 'failed' and file a task so a human sends it by
// hand — the spec's own fallback, just triggered by anything other than a
// confirmed send, not only a missing key.
async function checkScheduledMessages() {
  const nowIso = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('re_scheduled_messages')
    .select(`
      id, organization_id, customer_id, message, scheduled_for,
      re_customers(full_name, phone, whatsapp_opt_out)`)
    .eq('status', 'pending')
    .lte('scheduled_for', nowIso);
  if (error) throw error;

  let sent = 0;
  let failed = 0;
  let optedOut = 0;

  await mapWithConcurrency(data || [], SWEEP_CONCURRENCY, async (row) => {
    const customer = row.re_customers || {};

    // FEATURE — WhatsApp payment collection loop / opt-out enforcement.
    // "Excluded from ALL automated messages" has to mean this sweep too,
    // not just dealManager.sendWithClearance's own agents — this is a
    // second, independent send path (a rep's own scheduled follow-up, or
    // (SECTION 6) collectionsAgent's optimal-time deferral) that reached
    // straight for notify.sendWhatsApp with no clearance check at all.
    // Cancelled, not failed: nothing went wrong, and filing the usual
    // fallback task below would mean asking a rep to chase down someone who
    // explicitly asked not to be messaged — the opposite of honouring STOP.
    if (customer.whatsapp_opt_out) {
      await supabaseAdmin
        .from('re_scheduled_messages')
        .update({ status: 'cancelled' })
        .eq('id', row.id);
      optedOut += 1;
      return;
    }

    const result = customer.phone
      ? await notify.sendWhatsApp({
          orgId: row.organization_id,
          to: customer.phone,
          body: row.message,
          template: 'scheduled_message',
          relatedType: 're_scheduled_messages',
          relatedId: row.id,
        })
      : { status: 'skipped', reason: 'no phone on file' };

    const wasSent = result.status === 'sent';
    await supabaseAdmin
      .from('re_scheduled_messages')
      .update({ status: wasSent ? 'sent' : 'failed', sent_at: wasSent ? new Date().toISOString() : null })
      .eq('id', row.id);

    if (wasSent) {
      sent += 1;
      return;
    }
    failed += 1;

    const { error: taskError } = await supabaseAdmin.from('re_tasks').insert({
      organization_id: row.organization_id,
      title: `Send scheduled message to ${customer.full_name || 'a buyer'}`,
      notes: `Was due to send automatically at ${row.scheduled_for} but could not (${result.reason || 'unknown reason'}). `
        + `Message: "${row.message}"`,
      source: 'ai',
    });
    if (taskError) console.warn('[scheduled-messages] could not file fallback task:', taskError.message);
  });

  return { evaluated: (data || []).length, sent, failed, opted_out: optedOut };
}

module.exports = { listForCustomer, schedule, cancel, checkScheduledMessages };
