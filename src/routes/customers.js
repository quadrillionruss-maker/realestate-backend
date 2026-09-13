const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission, isOwnRecordsOnly, assertPermission } = require('../middleware/rbac');
const { canAccess } = require('../services/permissions');
const { issuePortalToken, portalUrl } = require('../services/portalService');
const notify = require('../services/notificationService');
const { audit } = require('../services/auditService');
const { sanitizeSearchTerm } = require('../utils/searchFilter');
const { mapWithConcurrency } = require('../utils/concurrency');
const creditScore = require('../services/creditScoreService');
const contactTiming = require('../services/contactTimingService');
const referrals = require('../services/referralService');
const messages = require('../services/messageService');
const outcomes = require('../services/outcomeService');
const behavioralFingerprint = require('../services/behavioralFingerprintService');
const decisionLedger = require('../services/decisionLedgerService');
const { lagosToday } = require('../services/overdueService');
const router = express.Router();

// AUDIT FIX — every route below keys off :id, and a request built from a
// stale or unresolved frontend value (a buyer link rendered before its id
// was known, e.g.) arrives here as an EMPTY path segment: GET
// /customers//activities, not a 404. Express still matches that against
// '/:id/activities' with id === '', so without this guard the empty string
// reaches Supabase and Postgres rejects it as invalid uuid input — a 500
// logged only to Render's console, with nothing in the admin dashboard's
// Client Errors feed (that table is populated by the FRONTEND reporting a
// caught exception in itself; a raw backend 500 like this one never reaches
// it). One router.param covers every :id route in this file, same UUID_RE
// pattern audit.js/reports.js/dashboard.js already each keep their own copy
// of, rather than repeating the check in all thirteen handlers.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) {
    // Logged here (not left to errorHandler.js, which only ever sees 5xx)
    // because this is the one clue to which SCREEN sent a malformed id —
    // the referer header, never row data, safe under CLAUDE.md's logging
    // rule — for tracing the frontend bug that produced it.
    console.warn(`[${new Date().toISOString()}] rejected non-uuid customer id "${id}" from ${req.get('referer') || 'unknown referer'}`);
    return res.status(400).json({ error: 'Invalid customer id.' });
  }
  next();
});

// Shared by the single-buyer send (POST /:id/portal-link) and the bulk send
// (POST /bulk-portal-link) — one place building this email so the two never
// drift into slightly different wording for the same link.
async function sendPortalLinkEmail(orgId, customer, url, settings) {
  const defaultHtml = notify.emailShell({
    heading: 'Your account is online',
    intro: 'See what you have paid, what is next, and download your documents — any time, without calling the office.',
    ctaLabel: 'Open my account',
    ctaUrl: url,
    footer: 'This link is personal to you. Do not forward it.',
  });
  const defaultSubject = `Your payment account with ${settings?.company_name || 'us'}`;

  // SECTION 14 — a workspace's own portal_link template, if saved, wins.
  const content = await notify.resolveEmailContent(orgId, 'portal_link', {
    buyer_name: customer.full_name || '',
    amount: '',
    unit: '',
    due_date: '',
    portal_link: url,
  }, { subject: defaultSubject, html: defaultHtml });

  return notify.sendEmail({
    orgId,
    to: customer.email,
    subject: content.subject,
    html: content.html,
    text: `View your payment account: ${url}`,
    template: 'portal_link',
    replyTo: settings?.reply_to_email || null,
    relatedType: 're_customers',
    relatedId: customer.id,
  });
}

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

    // SECTION 3 — credit_score is a judgment built from payment behaviour,
    // the same category of fact as an amount. Documentation, who "must
    // never see what a buyer paid", does not see this either.
    const rows = canAccess(req.orgRole, 'financial.view')
      ? data
      : (data || []).map((c) => ({ ...c, credit_score: null }));

    res.json(rows);
  } catch (e) { next(e); }
});

// Decision Ledger — brief-order override. The daily brief ranks who to
// contact first (payload.recommendations[0]); nothing before this recorded
// whether that buyer's page was actually opened first, or a different one
// was. Fires once per Lagos day, org-wide — not per-user: there is no
// precedent anywhere in this codebase for filtering a jsonb field via the
// Supabase JS client, and per-user would not remove the real ambiguity
// anyway, since recommendations[0] is one org-wide pick regardless of who
// opens what. Recorded against the RECOMMENDED customer (not whichever one
// was actually opened) so that buyer's own Decision History shows "Archta
// suggested you first today" even when the team worked someone else first.
// Wrapped so a failure here can never turn an ordinary buyer-detail read
// into a 500 — same "nothing here throws" rule decisionLedgerService.js's
// own header states.
async function maybeRecordBriefOrderDecision(req, openedCustomerId) {
  try {
    if (await decisionLedger.hasRecordedToday(req.orgId, 'collections_timing')) return;

    const { data: brief } = await supabaseAdmin
      .from('re_ai_briefs')
      .select('payload')
      .eq('organization_id', req.orgId)
      .eq('brief_date', lagosToday())
      .maybeSingle();
    // aiBrief.js's BRIEF_SCHEMA.recommendations items carry only
    // {title, reservation_id} — no customer_id/customer_ref — so resolving
    // to a customer needs its own lookup here.
    const topRecommendation = brief?.payload?.recommendations?.[0];
    if (!topRecommendation?.reservation_id) return;

    const { data: reservation } = await supabaseAdmin
      .from('re_reservations')
      .select('customer_id')
      .eq('id', topRecommendation.reservation_id)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    const recommendedCustomerId = reservation?.customer_id || null;
    if (!recommendedCustomerId) return;

    await decisionLedger.recordDecision(req.orgId, {
      customerId: recommendedCustomerId,
      reservationId: topRecommendation.reservation_id,
      recommendationType: 'collections_timing',
      archtaRecommendation: {
        action: 'contact_first', reservation_id: topRecommendation.reservation_id,
        customer_id: recommendedCustomerId, title: topRecommendation.title,
      },
      humanDecision: { action: 'opened_customer', customer_id: openedCustomerId, user_id: req.userId },
      wasOverride: recommendedCustomerId !== openedCustomerId,
    });
  } catch (err) {
    console.warn('[customers] could not record brief-order decision:', err.message);
  }
}

// Full buyer history: every reservation, its plan, and every installment.
// This is the screen a rep opens with the customer on the phone.
router.get('/:id', requirePermission('customers.read'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .select(`
        *,
        re_reservations(
          id, status, reserved_at, sales_rep_id, escalation_stage, property_type,
          re_joint_sales(id),
          re_sales_reps(id, active, users(full_name, email)),
          re_units(unit_number, list_price, re_projects(name, location)),
          re_installment_plans(
            id, total_amount, number_of_installments, frequency, start_date, created_at,
            status, superseded_by, restructured_at, restructure_reason,
            original_total_amount, carried_amount_paid,
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
      // SECTION 2 (feature expansion) — behavioral fingerprint. One
      // server-formatted sentence rather than the frontend re-deriving the
      // same three conditional clauses a second time — computed here,
      // behind the same financial.view gate as everything else nulled
      // below for Documentation, since a payment-day/promise-reliability
      // pattern is exactly the kind of financial-behavior signal that
      // boundary already exists to keep from them.
      data.behavioral_fingerprint_summary = behavioralFingerprint.describeFingerprint(data);
    } else {
      // Documentation: "Reservations (read only — status only)". Every
      // amount is stripped rather than the nested plan/schedule being
      // omitted outright, so the screen still shows which unit and which
      // installment is due WHEN without saying how much it is due for.
      stripFinancials(data);
    }

    // FEATURE — hardship request count on the buyer drawer, owner/director
    // only (the same tier that reviews these requests — permissions.js's
    // hardship.review — since a count with no way to act on it is just a
    // number nobody else on the team needs).
    if (canAccess(req.orgRole, 'hardship.review')) {
      const { data: hardshipRows } = await supabaseAdmin
        .from('re_hardship_requests')
        .select('status')
        .eq('organization_id', req.orgId)
        .eq('customer_id', data.id);
      const rows = hardshipRows || [];
      data.hardship_requests = {
        total: rows.length,
        pending: rows.filter((r) => r.status === 'pending').length,
        approved: rows.filter((r) => r.status === 'approved').length,
      };
    }

    // FEATURE — unread message badge on the buyer drawer, for whoever can
    // read this thread at all (messages.read — same tier that can open it).
    if (canAccess(req.orgRole, 'messages.read')) {
      data.unread_messages = await messages.unreadCountForCustomer(req.orgId, data.id, 'buyer');
    }

    // Decision Ledger — wrapped internally so a failure here can never turn
    // this read into a 500 (see the helper's own header above); awaited
    // rather than fire-and-forget for the same reason this route already
    // awaits its other side effects, and it's a no-op query on every
    // request after the first one each Lagos day.
    await maybeRecordBriefOrderDecision(req, data.id);

    res.json(data);
  } catch (e) { next(e); }
});

// Decision Ledger — buyer drawer's "Decision History" section. Same
// financial.view gate stripFinancials()/the rest of this route already use:
// amount_recovered is a naira figure, and Documentation never sees one.
router.get('/:id/decisions', requirePermission('customers.read'), async (req, res, next) => {
  try {
    const customer = await findOwnCustomer(req);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const rows = await decisionLedger.getForCustomer(req.orgId, customer.id);
    res.json(canAccess(req.orgRole, 'financial.view')
      ? rows
      : rows.map((r) => ({ ...r, amount_recovered: null })));
  } catch (e) { next(e); }
});

// Documentation sees a buyer's reservation shape (which unit, which
// installment, its status and date) without a single naira figure — see
// permissions.js's financial.view. Mutates in place; called only on the
// single-customer response, never the list (re_customers itself carries no
// amount of its own).
function stripFinancials(customer) {
  // SECTION 3 — same boundary as every amount on this object.
  customer.credit_score = null;
  // SECTION 2 (feature expansion) — behavioral fingerprint. Same boundary:
  // a payment-day pattern and a promise-reliability percentage are
  // financial-behavior signals, not amounts, but the same reasoning
  // credit_score is stripped for applies to them. preferred_contact_channel
  // is left alone — which channel reaches a buyer fastest is operational,
  // not financial.
  customer.preferred_payment_day_of_month = null;
  customer.avg_days_to_pay_after_reminder = null;
  customer.promise_reliability_score = null;
  customer.typical_payment_amount_pattern = null;
  customer.behavioral_fingerprint_summary = null;
  for (const reservation of customer.re_reservations || []) {
    if (reservation.re_units) reservation.re_units.list_price = null;
    const plans = Array.isArray(reservation.re_installment_plans)
      ? reservation.re_installment_plans
      : [reservation.re_installment_plans].filter(Boolean);
    for (const plan of plans) {
      plan.total_amount = null;
      // FEATURE — plan history tab surfaces these two alongside total_amount;
      // same boundary, same reasoning: a naira figure, stripped rather than
      // the plan itself omitted, so status/dates still show.
      plan.original_total_amount = null;
      plan.carried_amount_paid = null;
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
    const { full_name, email, phone, source, referral_code: referralCode } = req.body || {};
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
      // referral_code itself is left to the column's own DB default
      // (migrations/024) — same convention as never setting `id` by hand.
      .select()
      .single();
    if (error) throw error;

    // SECTION 5 — links referred_by_customer_id and opens the
    // re_customer_referrals workflow row. Never blocks buyer creation on a
    // bad or unused code — see referralService.linkReferral's own comment.
    let referral = null;
    if (referralCode) {
      referral = await referrals.linkReferral(req.orgId, data, referralCode);
    }

    audit(req, {
      action: 'customer.created',
      entityType: 're_customers',
      entityId: data.id,
      summary: `Buyer added: ${data.full_name}`
        + (referral ? ' — referred by an existing buyer' : ''),
      metadata: { source: data.source || null, referred_by_customer_id: referral?.referring_customer_id || null },
    });

    res.status(201).json(referral ? { ...data, referred_by_customer_id: referral.referring_customer_id } : data);
  } catch (e) { next(e); }
});

router.patch('/:id', requirePermission('customers.update'), async (req, res, next) => {
  try {
    const { full_name, email, phone, source, whatsapp_opt_out } = req.body || {};
    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (source !== undefined) updates.source = source;
    // AUDIT FIX (NF2) — narrower than customers.update (SELLERS, includes a
    // sales_rep): a consent setting affecting every automated send is a
    // director-level decision, checked inline rather than route-gated since
    // it depends on which field is actually present in this same PATCH.
    if (whatsapp_opt_out !== undefined) {
      if (!assertPermission(req, res, 'customers.whatsappOptOut')) return;
      updates.whatsapp_opt_out = Boolean(whatsapp_opt_out);
    }
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

// SECTION 7 — blacklist. Owner only (permissions.js's customers.blacklist).
// Blacklisting an already-blacklisted buyer (or unblacklisting one who
// isn't) is a no-op 200, not a 409 — the caller asked for a STATE, not a
// transition, and a double-click on the button must not error.
router.post('/:id/blacklist', requirePermission('customers.blacklist'), async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to blacklist a buyer.' });

    // AUDIT FIX (F13) — read before the write so a repeat call (two owners,
    // a retry) can tell "this call actually changed something" from "this
    // buyer was already blacklisted" — the update below stays a no-op 200
    // either way, but only a REAL transition gets a new reversible audit
    // entry. Without this, two calls produced two reversible entries for
    // one underlying state; undoing the first correctly un-blacklists the
    // buyer, and undoing the second then matches zero rows but still gets
    // marked "reversed" — a misleading double "Undone" trail for a buyer
    // who was only ever blacklisted once.
    const { data: existing } = await supabaseAdmin
      .from('re_customers').select('blacklisted')
      .eq('id', req.params.id).eq('organization_id', req.orgId).maybeSingle();

    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .update({
        blacklisted: true,
        blacklist_reason: reason,
        blacklisted_at: new Date().toISOString(),
        blacklisted_by: req.userId,
      })
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select('id, full_name, blacklisted, blacklist_reason, blacklisted_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Customer not found' });

    audit(req, {
      action: 'customer.blacklisted',
      entityType: 're_customers',
      entityId: data.id,
      summary: `${data.full_name || 'Buyer'} blacklisted — ${reason}`,
      metadata: { reason },
      // FEATURE — system log with undo.
      reversible: !existing?.blacklisted,
    });

    res.json(data);
  } catch (e) { next(e); }
});

router.post('/:id/unblacklist', requirePermission('customers.blacklist'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .update({ blacklisted: false, blacklist_reason: null, blacklisted_at: null, blacklisted_by: null })
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select('id, full_name, blacklisted')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Customer not found' });

    audit(req, {
      action: 'customer.unblacklisted',
      entityType: 're_customers',
      entityId: data.id,
      summary: `${data.full_name || 'Buyer'} unblacklisted`,
    });

    res.json(data);
  } catch (e) { next(e); }
});

// SECTION 3 — credit score breakdown. Gated the same way a naira figure
// on this screen always is: customers.read opens the door, financial.view
// decides whether what comes back has real numbers in it. A score is a
// judgment built FROM payment behaviour, so Documentation — who "must
// never see what a buyer paid" — gets the same 403 here it would get from
// any other financial content on this buyer.
router.get('/:id/credit-score', requirePermission('customers.read'), async (req, res, next) => {
  try {
    if (!canAccess(req.orgRole, 'financial.view')) {
      return res.status(403).json({ success: false, error: 'This role cannot view financial standing.' });
    }

    let query = supabaseAdmin
      .from('re_customers')
      .select('id, full_name, created_by_user_id')
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId);
    if (isOwnRecordsOnly(req.orgRole)) query = query.eq('created_by_user_id', req.userId);

    const { data: customer, error } = await query.maybeSingle();
    if (error) throw error;
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { score, breakdown } = await creditScore.computeBreakdown(req.orgId, customer.id);
    res.json({ customer_id: customer.id, score, tier: creditScore.tier(score), breakdown });
  } catch (e) { next(e); }
});

// ── Activity log ─────────────────────────────────────────────────────────
// Free-text call/visit/WhatsApp/email notes against a buyer — see
// migrations/029. Read follows the SAME visibility as the buyer record
// itself: a Sales Executive who cannot open this buyer at all (the 404 above)
// cannot see their activity notes either, and one who can see the buyer sees
// every note logged on it, not just their own.
const ACTIVITY_TYPES = ['call', 'visit', 'whatsapp', 'email', 'note', 'site_visit'];
const ACTIVITY_OUTCOMES = ['interested', 'not_interested', 'promised_payment', 'no_answer', 'follow_up_needed'];

// Shared by GET/POST/DELETE below: confirms the buyer exists in this org and,
// for a Sales Executive, that it is one of THEIR OWN buyers — the identical
// ownership check GET /:id already applies, so a rep gets the same 404 a
// stranger would rather than a 403 that confirms the buyer exists.
async function findOwnCustomer(req) {
  let query = supabaseAdmin
    .from('re_customers')
    .select('id, full_name, phone, email, created_by_user_id')
    .eq('id', req.params.id)
    .eq('organization_id', req.orgId);
  if (isOwnRecordsOnly(req.orgRole)) query = query.eq('created_by_user_id', req.userId);
  const { data } = await query.maybeSingle();
  return data;
}

router.get('/:id/activities', requirePermission('customers.read'), async (req, res, next) => {
  try {
    const customer = await findOwnCustomer(req);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { data, error } = await supabaseAdmin
      .from('re_activities')
      .select('id, activity_type, notes, outcome, created_at, logged_by_user_id, users(full_name, email)')
      .eq('organization_id', req.orgId)
      .eq('customer_id', customer.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;

    res.json(data);
  } catch (e) { next(e); }
});

router.post('/:id/activities', requirePermission('activities.write'), async (req, res, next) => {
  try {
    const customer = await findOwnCustomer(req);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { activity_type, notes, outcome } = req.body || {};
    if (!ACTIVITY_TYPES.includes(activity_type)) {
      return res.status(400).json({ error: `activity_type must be one of: ${ACTIVITY_TYPES.join(', ')}` });
    }
    if (!String(notes || '').trim()) {
      return res.status(400).json({ error: 'notes is required' });
    }
    if (outcome !== undefined && outcome !== null && !ACTIVITY_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${ACTIVITY_OUTCOMES.join(', ')}` });
    }

    const { data, error } = await supabaseAdmin
      .from('re_activities')
      .insert({
        organization_id: req.orgId,
        customer_id: customer.id,
        logged_by_user_id: req.userId,
        activity_type,
        notes: String(notes).trim(),
        outcome: outcome || null,
      })
      .select('id, activity_type, notes, outcome, created_at, logged_by_user_id, users(full_name, email)')
      .single();
    if (error) throw error;

    audit(req, {
      action: 'activity.logged',
      entityType: 're_activities',
      entityId: data.id,
      summary: `${activity_type} logged for customer`,
      metadata: { customer_id: customer.id, activity_type, outcome: outcome || null },
    });

    // FEATURE — dynamic reminder timing. An activity's outcome is one of
    // contactTimingService's two signals (the other is a payment) —
    // awaited the same way paymentEvents.js awaits creditScore.recompute
    // and defaultRisk.recompute: the function itself never throws, so
    // awaiting it costs nothing and keeps this consistent with every other
    // derived-figure recompute in the product.
    await contactTiming.recompute(req.orgId, customer.id);

    // SECTION 1 (feature expansion) — outcome database. Only 'call' maps
    // onto the fixed action_type enum unambiguously — 'visit'/'site_visit'/
    // 'note' have no clean equivalent there, and 'whatsapp'/'email' logged
    // here are a REP'S OWN note that they messaged the buyer some other
    // way, not this product's own automated send, so they are left out
    // rather than conflated with the tracked whatsapp_sent/email_sent
    // channels dealManager and campaignService write.
    if (activity_type === 'call') {
      await outcomes.recordAction(req.orgId, {
        customerId: customer.id, actionType: 'call_logged', channel: 'call',
      });
    }

    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.delete('/:id/activities/:activityId', requirePermission('activities.write'), async (req, res, next) => {
  try {
    const customer = await findOwnCustomer(req);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    let query = supabaseAdmin
      .from('re_activities')
      .select('id, logged_by_user_id')
      .eq('id', req.params.activityId)
      .eq('organization_id', req.orgId)
      .eq('customer_id', customer.id)
      .is('deleted_at', null);
    const { data: activity } = await query.maybeSingle();
    if (!activity) return res.status(404).json({ error: 'Activity not found' });

    // A Sales Executive may tidy up their OWN notes on their OWN buyer, but
    // not a collections officer's or a colleague's — the same "own it, not
    // just see it" boundary the removal reassignment above draws around who
    // may act, versus who may merely look.
    if (isOwnRecordsOnly(req.orgRole) && activity.logged_by_user_id !== req.userId) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const { error } = await supabaseAdmin
      .from('re_activities')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', activity.id)
      .eq('organization_id', req.orgId);
    if (error) throw error;

    audit(req, {
      action: 'activity.deleted',
      entityType: 're_activities',
      entityId: activity.id,
      summary: 'Activity note deleted',
      metadata: { customer_id: customer.id },
    });

    // AUDIT FIX (NF13) — the sibling create route above recomputes this;
    // deleting a wrongly-logged activity that fed the optimal_contact_hour
    // mode calculation left the buyer's contact-timing hint stale on the
    // now-deleted entry until the next unrelated payment/activity trigger.
    await contactTiming.recompute(req.orgId, customer.id);

    res.json({ deleted: true });
  } catch (e) { next(e); }
});

// ── Message thread ─────────────────────────────────────────────────────
// Reading marks the OTHER party's messages read — a staff member opening
// this thread has, by definition, just read whatever the buyer sent.
router.get('/:id/messages', requirePermission('messages.read'), async (req, res, next) => {
  try {
    const customer = await findOwnCustomer(req);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const data = await messages.listForCustomer(req.orgId, customer.id);
    await messages.markRead(req.orgId, customer.id, 'staff');
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/:id/messages', requirePermission('messages.write'), async (req, res, next) => {
  try {
    const customer = await findOwnCustomer(req);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const data = await messages.sendFromStaff(req, customer, req.body?.message);
    res.status(201).json(data);
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
      const result = await sendPortalLinkEmail(req.orgId, customer, url, settings);
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

// SECTION 4 — bulk send. Owner + sales director only (permissions.js's
// customers.bulkPortalLink) — narrower than the single-buyer send above
// (customers.portalAccess, which a rep or collections officer also has):
// emailing dozens of buyers in one click is a different, more consequential
// decision than handing one buyer their own link, the same reasoning
// audit.export sits narrower than audit.read.
router.post('/bulk-portal-link', requirePermission('customers.bulkPortalLink'), async (req, res, next) => {
  try {
    const customerIds = Array.isArray(req.body?.customer_ids) ? req.body.customer_ids : [];
    if (!customerIds.length) return res.status(400).json({ error: 'customer_ids is required.' });

    const { data: customers, error } = await supabaseAdmin
      .from('re_customers')
      .select('id, organization_id, full_name, email, portal_token_version')
      .eq('organization_id', req.orgId)
      .in('id', customerIds);
    if (error) throw error;

    const { data: settings } = await supabaseAdmin
      .from('re_org_settings').select('company_name, reply_to_email')
      .eq('organization_id', req.orgId).maybeSingle();

    // AUDIT FIX (P7) — an email send per buyer, run one at a time; a large
    // selection waited on this serially. mapWithConcurrency(4) matches
    // every other correctly-implemented sweep in this codebase.
    let sent = 0;
    let skippedNoEmail = 0;
    await mapWithConcurrency(customers || [], 4, async (customer) => {
      if (!customer.email) { skippedNoEmail += 1; return; }

      const token = issuePortalToken(customer);
      const url = portalUrl(token);
      const result = await sendPortalLinkEmail(req.orgId, customer, url, settings);
      if (result.status === 'sent') sent += 1;

      audit(req, {
        action: 'portal.link_issued',
        entityType: 're_customers',
        entityId: customer.id,
        summary: `Portal link issued for ${customer.full_name} — bulk send`,
        metadata: { emailed: result.status },
      });
    });

    res.json({ sent, skipped_no_email: skippedNoEmail, total: (customers || []).length });
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
