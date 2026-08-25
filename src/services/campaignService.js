// campaignService.js — SECTION 11 (feature expansion): bulk email/SMS/
// WhatsApp sends to a chosen slice of the buyer list, with per-recipient
// delivery tracking.
//
// Reuses the existing provider adapters end to end — notificationService's
// sendEmail (Resend), sendSms (Termii) and sendWhatsApp (WhatsApp Business
// API) — the same three channels every other automated message in this
// product already goes through, per-workspace credentials and all. Nothing
// here talks to a provider directly.
//
// delivered_count mirrors sent_count: this product has no delivery-receipt
// webhook for any of the three channels yet (re_notifications records what
// WAS ATTEMPTED, not a provider's own delivered/opened callback), so
// "delivered" here means "the provider accepted it for sending", the same
// honest limit re_notifications' own 'sent' status already carries.
const { supabaseAdmin } = require('../middleware/orgContext');
const notify = require('./notificationService');
const { mapWithConcurrency } = require('../utils/concurrency');
const { escapeHtml } = require('../utils/escapeHtml');

const TYPES = ['email', 'sms', 'whatsapp'];
const AUDIENCES = ['all', 'overdue', 'project', 'credit_below'];
const SEND_CONCURRENCY = 8;

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

async function list(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_campaigns').select('*')
    .eq('organization_id', orgId).is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function get(orgId, id) {
  const { data, error } = await supabaseAdmin
    .from('re_campaigns').select('*')
    .eq('id', id).eq('organization_id', orgId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  return data;
}

function validateFilter(filter = {}) {
  const audience = filter.audience || 'all';
  if (!AUDIENCES.includes(audience)) throw badRequest(`target_filter.audience must be one of: ${AUDIENCES.join(', ')}`);
  if (audience === 'project' && !filter.project_id) throw badRequest('target_filter.project_id is required for the "project" audience');
  if (audience === 'credit_below' && !Number.isFinite(Number(filter.credit_score_below))) {
    throw badRequest('target_filter.credit_score_below must be a number for the "credit_below" audience');
  }
}

async function create(req, { name, type, message_body: messageBody, target_filter: targetFilter }) {
  if (!name || !String(name).trim()) throw badRequest('name is required');
  if (!TYPES.includes(type)) throw badRequest(`type must be one of: ${TYPES.join(', ')}`);
  if (!messageBody || !String(messageBody).trim()) throw badRequest('message_body is required');
  validateFilter(targetFilter);

  const { data, error } = await supabaseAdmin
    .from('re_campaigns')
    .insert({
      organization_id: req.orgId,
      name: String(name).trim(),
      type,
      message_body: String(messageBody).trim(),
      target_filter: targetFilter || {},
      created_by: req.userId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function update(orgId, id, updates = {}) {
  const existing = await get(orgId, id);
  if (!existing) return { notFound: true };
  if (existing.status === 'sent') throw badRequest('A sent campaign cannot be edited.');

  const allowed = {};
  if (updates.name !== undefined) allowed.name = String(updates.name).trim();
  if (updates.message_body !== undefined) allowed.message_body = String(updates.message_body).trim();
  if (updates.target_filter !== undefined) {
    validateFilter(updates.target_filter);
    allowed.target_filter = updates.target_filter;
  }
  if (updates.scheduled_for !== undefined) {
    allowed.scheduled_for = updates.scheduled_for;
    allowed.status = updates.scheduled_for ? 'scheduled' : 'draft';
  }
  if (!Object.keys(allowed).length) throw badRequest('Nothing to update.');

  const { data, error } = await supabaseAdmin
    .from('re_campaigns').update(allowed).eq('id', id).eq('organization_id', orgId).select().single();
  if (error) throw error;
  return data;
}

async function fetchCustomersByIds(orgId, ids) {
  if (!ids.length) return [];
  const { data, error } = await supabaseAdmin
    .from('re_customers')
    .select('id, full_name, email, phone, whatsapp_opt_out')
    .eq('organization_id', orgId)
    .in('id', ids);
  if (error) throw error;
  return data || [];
}

// Every target_filter shape the product spec names. Returns the actual
// customer rows a send would reach — the same function preview() and
// send() both call, so a preview can never disagree with what actually
// goes out.
async function resolveAudience(orgId, filter = {}) {
  validateFilter(filter);
  const audience = filter.audience || 'all';

  if (audience === 'overdue') {
    const { data, error } = await supabaseAdmin
      .from('re_installment_schedule')
      .select('re_installment_plans!inner(re_reservations!inner(customer_id))')
      .eq('organization_id', orgId)
      .eq('status', 'overdue');
    if (error) throw error;
    const ids = [...new Set((data || [])
      .map((row) => row.re_installment_plans?.re_reservations?.customer_id)
      .filter(Boolean))];
    return fetchCustomersByIds(orgId, ids);
  }

  if (audience === 'project') {
    const { data, error } = await supabaseAdmin
      .from('re_reservations')
      .select('customer_id, re_units!inner(project_id)')
      .eq('organization_id', orgId)
      .eq('re_units.project_id', filter.project_id)
      .neq('status', 'cancelled');
    if (error) throw error;
    const ids = [...new Set((data || []).map((row) => row.customer_id).filter(Boolean))];
    return fetchCustomersByIds(orgId, ids);
  }

  if (audience === 'credit_below') {
    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .select('id, full_name, email, phone, whatsapp_opt_out, credit_score')
      .eq('organization_id', orgId)
      .lt('credit_score', Number(filter.credit_score_below));
    if (error) throw error;
    return data || [];
  }

  const { data, error } = await supabaseAdmin
    .from('re_customers').select('id, full_name, email, phone, whatsapp_opt_out').eq('organization_id', orgId);
  if (error) throw error;
  return data || [];
}

// The "preview the recipient list" step the product spec asks for, before
// a draft is actually sent — no side effects, just who this would reach.
async function previewAudience(orgId, filter) {
  const customers = await resolveAudience(orgId, filter);
  return { count: customers.length, sample: customers.slice(0, 20).map((c) => ({ id: c.id, full_name: c.full_name })) };
}

async function sendToOne(orgId, campaign, customer) {
  if (campaign.type === 'email') {
    if (!customer.email) return { status: 'skipped', reason: 'no email on file' };
    return notify.sendEmail({
      orgId, to: customer.email, subject: campaign.name,
      html: `<p>${escapeHtml(campaign.message_body).replace(/\n/g, '<br>')}</p>`,
      text: campaign.message_body,
      template: 'campaign', relatedType: 're_campaigns', relatedId: campaign.id,
    });
  }

  if (!customer.phone) return { status: 'skipped', reason: 'no phone on file' };

  // FEATURE — WhatsApp payment collection loop's own opt-out rule applies
  // here too: "excluded from all automated messages" has to mean bulk
  // campaigns, not just the collections/scheduled-message paths.
  if (campaign.type === 'whatsapp' && customer.whatsapp_opt_out) {
    return { status: 'skipped', reason: 'buyer opted out of WhatsApp' };
  }

  return campaign.type === 'whatsapp'
    ? notify.sendWhatsApp({ orgId, to: customer.phone, body: campaign.message_body, template: 'campaign', relatedType: 're_campaigns', relatedId: campaign.id })
    : notify.sendSms({ orgId, to: customer.phone, body: campaign.message_body, template: 'campaign', relatedType: 're_campaigns', relatedId: campaign.id });
}

async function send(req, campaignId) {
  const campaign = await get(req.orgId, campaignId);
  if (!campaign) return { notFound: true };
  if (campaign.status === 'sent') throw badRequest('This campaign has already been sent.');

  const customers = await resolveAudience(req.orgId, campaign.target_filter || {});

  let sent = 0;
  let failed = 0;

  await mapWithConcurrency(customers, SEND_CONCURRENCY, async (customer) => {
    const result = await sendToOne(req.orgId, campaign, customer);
    const wasSent = result.status === 'sent';
    if (wasSent) sent += 1; else failed += 1;

    await supabaseAdmin
      .from('re_campaign_deliveries')
      .upsert({
        campaign_id: campaign.id,
        customer_id: customer.id,
        status: wasSent ? 'delivered' : 'failed',
        sent_at: wasSent ? new Date().toISOString() : null,
        delivered_at: wasSent ? new Date().toISOString() : null,
        error_message: wasSent ? null : String(result.reason || 'send failed').slice(0, 500),
      }, { onConflict: 'campaign_id,customer_id' });
  });

  const { data: updated, error } = await supabaseAdmin
    .from('re_campaigns')
    .update({
      status: 'sent', sent_at: new Date().toISOString(),
      sent_count: sent, delivered_count: sent, failed_count: failed,
    })
    .eq('id', campaign.id).eq('organization_id', req.orgId)
    .select().single();
  if (error) throw error;
  return updated;
}

async function deliveries(orgId, campaignId) {
  const campaign = await get(orgId, campaignId);
  if (!campaign) return null;
  const { data, error } = await supabaseAdmin
    .from('re_campaign_deliveries')
    .select('*, re_customers(full_name)')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return { campaign, deliveries: data || [] };
}

module.exports = {
  TYPES, AUDIENCES, list, get, create, update, previewAudience, resolveAudience, send, deliveries,
};
