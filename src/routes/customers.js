const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission, isOwnRecordsOnly } = require('../middleware/rbac');
const { canAccess } = require('../services/permissions');
const { issuePortalToken, portalUrl } = require('../services/portalService');
const notify = require('../services/notificationService');
const { audit } = require('../services/auditService');
const { sanitizeSearchTerm } = require('../utils/searchFilter');
const router = express.Router();

router.get('/', requirePermission('customers.read'), async (req, res, next) => {
  try {
    // Unbounded until now — a developer several years in has thousands of
    // buyers, and every one of them came back on every load of this screen.
    // Same cap shape as payments.js: a default that covers a normal
    // workspace, a ceiling nobody needs to exceed in one page.
    // Floored as well as capped — a negative or zero limit reached Postgres
    // unvalidated and surfaced as an opaque error rather than a clear 400.
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 500, 2000));

    let query = supabaseAdmin
      .from('re_customers')
      .select('*')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false })
      .limit(limit);

    // A Sales Executive sees only the buyers THEY added. Everyone else who
    // can open this screen at all (owner, sales director, collections,
    // documentation) sees every buyer — created_by_user_id is provenance for
    // them, not an access filter.
    if (isOwnRecordsOnly(req.orgRole)) {
      query = query.eq('created_by_user_id', req.userId);
    }

    if (req.query.search) {
      // Sales staff search by whatever they have to hand — a name, the phone
      // number from a WhatsApp thread, or an email.
      const term = sanitizeSearchTerm(req.query.search);
      query = query.or(`full_name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Full buyer history: every reservation, its plan, and every installment.
// This is the screen a rep opens with the customer on the phone.
router.get('/:id', requirePermission('customers.read'), async (req, res, next) => {
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

    // Same boundary as the list above: a Sales Executive who is not this
    // buyer's own rep gets the same 404 a stranger would, not a 403 that
    // confirms the buyer exists.
    if (isOwnRecordsOnly(req.orgRole) && data.created_by_user_id !== req.userId) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    if (canAccess(req.orgRole, 'financial.view')) {
      data.unallocated_credit = await findUnallocatedCredit(req.orgId, data);
    } else {
      // Documentation: "Reservations (read only — status only)". Every
      // amount is stripped rather than the nested plan/schedule being
      // omitted outright, so the screen still shows which unit and which
      // installment is due WHEN without saying how much it is due for.
      stripFinancials(data);
    }

    res.json(data);
  } catch (e) { next(e); }
});

// Documentation sees a buyer's reservation shape (which unit, which
// installment, its status and date) without a single naira figure — see
// permissions.js's financial.view. Mutates in place; called only on the
// single-customer response, never the list (re_customers itself carries no
// amount of its own).
function stripFinancials(customer) {
  for (const reservation of customer.re_reservations || []) {
    if (reservation.re_units) reservation.re_units.list_price = null;
    const plans = Array.isArray(reservation.re_installment_plans)
      ? reservation.re_installment_plans
      : [reservation.re_installment_plans].filter(Boolean);
    for (const plan of plans) {
      plan.total_amount = null;
      for (const row of plan.re_installment_schedule || []) row.amount_due = null;
    }
  }
}

// A payment that overpaid its installment leaves a real credit. This reads
// it from the database rather than the per-device reminder the UI used to
// keep in localStorage, so any staff member on any device sees the same
// unresolved credit — not just whoever's browser recorded the payment.
async function findUnallocatedCredit(orgId, customer) {
  const scheduleIds = [];
  for (const reservation of customer.re_reservations || []) {
    const plans = Array.isArray(reservation.re_installment_plans)
      ? reservation.re_installment_plans
      : [reservation.re_installment_plans].filter(Boolean);
    for (const plan of plans) {
      for (const row of plan.re_installment_schedule || []) scheduleIds.push(row.id);
    }
  }
  if (!scheduleIds.length) return null;

  const { data: overpaid } = await supabaseAdmin
    .from('re_payments')
    .select('id, overpayment, paid_at')
    .eq('organization_id', orgId)
    .in('schedule_id', scheduleIds)
    .gt('overpayment', 0)
    .is('voided_at', null)
    .order('paid_at', { ascending: false });
  if (!overpaid?.length) return null;

  // Excludes credit already moved elsewhere — a payment can only be the
  // source of one LIVE reallocation (migrations/007's unique index applies
  // to non-voided rows in practice, since a voided reallocation frees the
  // credit again), so this is exactly the "has this one been spent yet" check.
  const { data: spent } = await supabaseAdmin
    .from('re_payments')
    .select('reallocated_from_payment_id')
    .eq('organization_id', orgId)
    .in('reallocated_from_payment_id', overpaid.map((p) => p.id))
    .is('voided_at', null);
  const spentIds = new Set((spent || []).map((s) => s.reallocated_from_payment_id));

  const live = overpaid.find((p) => !spentIds.has(p.id));
  if (!live) return null;

  return { payment_id: live.id, amount: Number(live.overpayment) };
}

router.post('/', requirePermission('customers.create'), async (req, res, next) => {
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
        // Who added this buyer — the fact "a Sales Executive sees only their
        // own buyers" is built on (migrations/016). Recorded for every role,
        // not only sales_rep: it is provenance either way, and an owner or
        // director who adds a buyer today should not read as "nobody" if a
        // rep is added to the workspace tomorrow.
        created_by_user_id: req.userId,
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

router.patch('/:id', requirePermission('customers.update'), async (req, res, next) => {
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

    let query = supabaseAdmin
      .from('re_customers')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      // orgContext's soft-delete filter only wraps .select() — an
      // update-then-select chain like this one is unfiltered by default, so
      // without this a PATCH could match and return a soft-deleted buyer's
      // full PII, which is invisible everywhere else in the product.
      .is('deleted_at', null);

    // A Sales Executive can only edit their own buyers — enforced as part of
    // the update's own WHERE clause, so someone else's row simply doesn't
    // match rather than needing a separate read-then-check.
    if (isOwnRecordsOnly(req.orgRole)) query = query.eq('created_by_user_id', req.userId);

    const { data, error } = await query.select().maybeSingle();
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
router.post('/:id/portal-link', requirePermission('customers.portalAccess'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_customers')
      .select('id, organization_id, full_name, email, phone, portal_token_version, created_by_user_id')
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId);
    if (isOwnRecordsOnly(req.orgRole)) query = query.eq('created_by_user_id', req.userId);

    const { data: customer, error } = await query.maybeSingle();
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
router.post('/:id/portal-revoke', requirePermission('customers.portalAccess'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_customers').select('id, full_name, portal_token_version, created_by_user_id')
      .eq('id', req.params.id).eq('organization_id', req.orgId);
    if (isOwnRecordsOnly(req.orgRole)) query = query.eq('created_by_user_id', req.userId);

    const { data: customer } = await query.maybeSingle();
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
