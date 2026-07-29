const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { issuePortalToken, portalUrl } = require('../services/portalService');
const notify = require('../services/notificationService');
const { audit } = require('../services/auditService');
const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_customers')
      .select('*')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });

    if (req.query.search) {
      // Sales staff search by whatever they have to hand — a name, the phone
      // number from a WhatsApp thread, or an email.
      // % and _ are escaped so a search for "100%" isn't read as a wildcard.
      const term = String(req.query.search).replace(/[%_]/g, (c) => `\\${c}`);
      query = query.or(`full_name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Full buyer history: every reservation, its plan, and every installment.
// This is the screen a rep opens with the customer on the phone.
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .select(`
        *,
        re_reservations(
          id, status, reserved_at,
          re_units(unit_number, list_price, re_projects(name, location)),
          re_installment_plans(
            id, total_amount, number_of_installments, frequency, start_date,
            re_installment_schedule(id, installment_number, due_date, amount_due, status, paid_at)
          )
        )`)
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { full_name, email, phone, source } = req.body || {};
    if (!full_name) return res.status(400).json({ error: 'full_name is required' });

    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .insert({
        organization_id: req.orgId,
        full_name,
        email: email || null,
        phone: phone || null,
        source: source || null,
      })
      .select()
      .single();
    if (error) throw error;

    audit(req, {
      action: 'customer.created',
      entityType: 're_customers',
      entityId: data.id,
      summary: `Buyer added: ${data.full_name}`,
      metadata: { source: data.source || null },
    });

    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { full_name, email, phone, source } = req.body || {};
    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (source !== undefined) updates.source = source;
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (e) { next(e); }
});

// ── Buyer portal ───────────────────────────────────────────────────────────
// Issues a signed link the developer sends by WhatsApp. It answers "how much
// have I paid", "when is the next one" and "can I have my allocation letter"
// without anyone picking up a phone — see src/services/portalService.js for
// why it is a link rather than an account.
router.post('/:id/portal-link', async (req, res, next) => {
  try {
    const { data: customer, error } = await supabaseAdmin
      .from('re_customers')
      .select('id, organization_id, full_name, email, phone, portal_token_version')
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const token = issuePortalToken(customer);
    const url = portalUrl(token);

    let emailed = 'skipped';
    if (req.body?.send_email && customer.email) {
      const { data: settings } = await supabaseAdmin
        .from('re_org_settings').select('company_name, reply_to_email')
        .eq('organization_id', req.orgId).maybeSingle();

      const result = await notify.sendEmail({
        orgId: req.orgId,
        to: customer.email,
        subject: `Your payment account with ${settings?.company_name || 'us'}`,
        html: notify.emailShell({
          heading: 'Your account is online',
          intro: 'See what you have paid, what is next, and download your documents — any time, without calling the office.',
          ctaLabel: 'Open my account',
          ctaUrl: url,
          footer: 'This link is personal to you. Do not forward it.',
        }),
        text: `View your payment account: ${url}`,
        template: 'portal_link',
        replyTo: settings?.reply_to_email || null,
        relatedType: 're_customers',
        relatedId: customer.id,
      });
      emailed = result.status;
    }

    audit(req, {
      action: 'portal.link_issued',
      entityType: 're_customers',
      entityId: customer.id,
      summary: `Portal link issued for ${customer.full_name}`,
      metadata: { emailed },
    });

    res.json({ url, token, emailed, expires_in_days: require('../config/env').portal.tokenTtlDays });
  } catch (e) { next(e); }
});

// The revoke button. Bumping the version invalidates every link ever issued to
// this buyer — which matters, because links get forwarded.
router.post('/:id/portal-revoke', async (req, res, next) => {
  try {
    const { data: customer } = await supabaseAdmin
      .from('re_customers').select('id, full_name, portal_token_version')
      .eq('id', req.params.id).eq('organization_id', req.orgId).maybeSingle();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .update({ portal_token_version: Number(customer.portal_token_version || 0) + 1 })
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select('id, portal_token_version')
      .single();
    if (error) throw error;

    audit(req, {
      action: 'portal.revoked',
      entityType: 're_customers',
      entityId: customer.id,
      summary: `Portal access revoked for ${customer.full_name}`,
    });

    res.json({ revoked: true, portal_token_version: data.portal_token_version });
  } catch (e) { next(e); }
});

module.exports = router;
