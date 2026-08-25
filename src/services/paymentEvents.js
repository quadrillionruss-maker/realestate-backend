// paymentEvents.js — everything that should happen after money lands.
//
// Money arrives by two doors: the Paystack webhook and a manually recorded
// bank transfer. Before this file, each door did its own bookkeeping and only
// its own. That is how a buyer who pays by transfer gets no receipt while one
// who pays by card does, and how a rep's commission depends on which button
// the admin pressed.
//
// So both doors now call onPaymentRecorded(). One place decides what a
// payment means:
//
//   1. accrue the sales rep's commission        (idempotent on payment_id)
//   2. render and store a receipt PDF           (idempotent on payment_id)
//   3. email the receipt to the buyer, SMS them (logged to re_notifications)
//   4. close any open promise-to-pay            (they said Friday; they paid)
//   5. wind back escalation if the plan is current again
//   6. write the audit entry
//
// NOTHING HERE THROWS. The payment is already in the database by the time
// this runs; a receipt that failed to render must not turn a recorded ₦5m
// into a 500 and a retried double-payment. Every step is caught, and the
// summary of what did and did not happen is returned to the caller.

const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const commissions = require('./commissionService');
const receipts = require('./receiptService');
const notify = require('./notificationService');
const { auditSystem } = require('./auditService');
const { escapeHtml } = require('../utils/escapeHtml');
const creditScore = require('./creditScoreService');
const defaultRisk = require('./defaultRiskService');
const contactTiming = require('./contactTimingService');
const jointSale = require('./jointSaleService');
const referrals = require('./referralService');
const pushService = require('./pushService');
const portalNotifications = require('./portalNotificationService');
const featureUsage = require('./featureUsageService');
const { generateDocument } = require('./documentService');

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

const formatDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// `source` is 'paystack' | 'manual' | 'portal' — it decides how the audit
// entry is attributed, which is the whole point of having one.
async function onPaymentRecorded({ orgId, paymentId, source = 'manual', actor = null, overpayment = 0 }) {
  const outcome = {
    commission: 'skipped',
    receipt: 'skipped',
    buyer_email: 'skipped',
    buyer_sms: 'skipped',
    buyer_whatsapp: 'skipped',
    promise: 'none',
    overpayment: Number(overpayment) || 0,
  };

  let receipt = null;

  // ── Receipt ──────────────────────────────────────────────────────────────
  // Rendered first because its context query is also the cheapest way to load
  // everything the later steps need.
  if (env.features.autoReceipts) {
    try {
      const result = await receipts.generateReceipt(orgId, paymentId);
      if (result.notFound) {
        outcome.receipt = 'failed: payment context not found';
      } else {
        receipt = result;
        outcome.receipt = 'generated';
      }
    } catch (err) {
      // Puppeteer is the flakiest thing in this process and the least
      // important one. Losing the PDF must not lose the payment.
      console.warn('[payment-events] receipt generation failed:', err.message);
      outcome.receipt = `failed: ${err.message}`;
    }
  }

  const context = receipt?.context || (await safeContext(orgId, paymentId));
  if (!context) return outcome;

  const { payment, schedule, plan, reservation, customer, unit, project, salesRep } = context;
  const settings = await orgSettings(orgId);

  // ── Commission ───────────────────────────────────────────────────────────
  const accrual = await commissions.accrueForPayment({ orgId, payment, reservation, salesRep });
  outcome.commission = accrual.accrued ? `accrued ${naira(accrual.commission.amount)}` : accrual.reason;

  // ── Joint sale — external agent statements (FEATURE — joint sales) ───────
  // Only when a commission actually accrued — no accrual (no rep, no rate,
  // already accrued) means nothing to split or state.
  if (accrual.accrued) {
    await jointSale.notifyExternalParties(orgId, {
      reservation, customer, unit, project, payment,
      commissionAmount: accrual.commission.amount,
      companyName: settings.company_name,
    });
  }

  // ── Tell the buyer ───────────────────────────────────────────────────────
  if (settings.notify_on_payment !== false) {
    const projectLine = [project.name, unit.unit_number && `Unit ${unit.unit_number}`]
      .filter(Boolean).join(' · ');

    if (customer.email) {
      const defaultHtml = notify.emailShell({
        heading: 'Payment received',
        intro: `We have received ${naira(payment.amount)} towards ${projectLine || 'your purchase'}. Your receipt is attached.`,
        rows: [
          ['Amount received', naira(payment.amount)],
          ['Installment', `${schedule.installment_number} of ${plan.number_of_installments}`],
          ['Total paid to date', naira(context.totalPaid)],
          ['Balance outstanding', naira(context.balance)],
        ],
        body: nextDueBlock(context),
        footer: `${settings.company_name || 'Your developer'} · Keep this receipt for your records.`,
      });
      const defaultSubject = `Receipt for ${naira(payment.amount)} — ${projectLine || 'your purchase'}`;

      // SECTION 14 — a workspace's own template, if it saved one, wins;
      // otherwise the built-in email above is exactly what always sent.
      const content = await notify.resolveEmailContent(orgId, 'receipt', {
        buyer_name: customer.full_name || '',
        amount: naira(payment.amount),
        unit: unit.unit_number || '',
        due_date: '',
        portal_link: '',
      }, { subject: defaultSubject, html: defaultHtml });

      const result = await notify.sendEmail({
        orgId,
        to: customer.email,
        subject: content.subject,
        html: content.html,
        text: `We received ${naira(payment.amount)}. Total paid: ${naira(context.totalPaid)}. Balance: ${naira(context.balance)}.`,
        template: 'payment_receipt',
        replyTo: settings.reply_to_email || null,
        relatedType: 're_payments',
        relatedId: paymentId,
        attachments: receipt?.pdf
          ? [{ filename: `${receipt.receipt_number}.pdf`, content: receipt.pdf }]
          : null,
      });
      outcome.buyer_email = result.status;
    }

    if (customer.phone) {
      const result = await notify.sendSms({
        orgId,
        to: customer.phone,
        body: `${settings.company_name || 'Your developer'}: we received ${naira(payment.amount)} for ${projectLine || 'your unit'}. `
          + `Balance ${naira(context.balance)}. Receipt sent to your email.`,
        template: 'payment_receipt_sms',
        relatedType: 're_payments',
        relatedId: paymentId,
      });
      outcome.buyer_sms = result.status;
    }

    // FEATURE — WhatsApp payment collection loop. "When the Paystack
    // webhook confirms payment: send a WhatsApp receipt confirmation
    // automatically" — the last link in the loop (reminder → buyer replies
    // PAY → Paystack link → pays → receipt), specifically for the Paystack
    // door: a bank transfer recorded by staff already gets exactly this
    // information by email and SMS above, and staff were already in the
    // buyer's conversation to record it. whatsapp_opt_out is honoured here
    // too, same as every other automated send.
    if (source === 'paystack' && customer.phone && !customer.whatsapp_opt_out) {
      const result = await notify.sendWhatsApp({
        orgId,
        to: customer.phone,
        body: `${settings.company_name || 'Your developer'}: payment received! ` +
          `${naira(payment.amount)} for ${projectLine || 'your unit'}. Balance ${naira(context.balance)}. ` +
          'Your receipt has been emailed to you.',
        template: 'payment_receipt_whatsapp',
        relatedType: 're_payments',
        relatedId: paymentId,
      });
      outcome.buyer_whatsapp = result.status;
    }
  }

  // ── Close the loop on a promise ──────────────────────────────────────────
  // "I'll transfer on Friday" followed by a transfer is a kept promise, and a
  // rep whose buyers keep their promises should be visible as such.
  if (schedule?.status === 'paid') {
    try {
      const { data: kept } = await supabaseAdmin
        .from('re_payment_promises')
        .update({ status: 'kept', resolved_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('schedule_id', schedule.id)
        .eq('status', 'open')
        .select('id');
      if (kept?.length) outcome.promise = 'kept';
    } catch (err) {
      console.warn('[payment-events] could not close promise:', err.message);
    }

    // If nothing is overdue on this reservation any more, the buyer is back in
    // good standing and should stop receiving formal-notice wording.
    await maybeDeescalate(orgId, reservation.id);
  }

  // ── Outright sale completion (FEATURE — outright sales) ──────────────────
  // An outright reservation always has a one-row plan due immediately (see
  // routes/reservations.js) — its single schedule row reaching 'paid' IS the
  // full price arriving, so this is "one payment records the full amount"
  // exactly, no per-cent tracking needed. Never blocks a payment already in
  // the database — same rule as everything else in this file.
  if (reservation.property_type === 'outright' && schedule?.status === 'paid') {
    try {
      await completeOutrightSale({ orgId, reservation, unit, source, actor });
    } catch (err) {
      console.warn('[payment-events] could not complete outright sale:', err.message);
    }
  }

  // ── Credit score (SECTION 3) ─────────────────────────────────────────────
  // Every payment can move either the consistency or default-history
  // dimension, so it is recomputed after every one — never throws, per this
  // file's own rule.
  await creditScore.recompute(orgId, customer.id);

  // ── Default risk score (SECTION 5 — feature expansion) ───────────────────
  // Reservation-scoped, updated after every payment event exactly like the
  // customer-level credit score just above — see defaultRiskService.js for
  // why this is a separate number from credit_score rather than the same one.
  await defaultRisk.recompute(orgId, reservation.id);

  // ── Optimal contact time (SECTION 6 — feature expansion) ──────────────────
  // A payment is one of the two signals this reads (the other is activity
  // log entries) — see contactTimingService.js.
  await contactTiming.recompute(orgId, customer.id);

  // ── Referral completion (SECTION 5) ──────────────────────────────────────
  // A no-op unless this customer was referred AND this is their first ever
  // payment — see referralService.handleFirstPayment's own comment for how
  // that is detected without counting payments. Never throws, per this
  // file's own rule.
  const referralCompleted = await referrals.handleFirstPayment(orgId, customer.id);
  if (referralCompleted) featureUsage.track(orgId, 'referral_made');

  // ── Push notification (SECTION 1) ────────────────────────────────────────
  // Owner + whichever sales rep is assigned to this reservation (a reservation
  // with no rep assigned notifies the owner only — resolveUserIdsByRole
  // already returns nothing for a role with no members). pushService itself
  // never throws (a configured-but-unreachable push service degrades the
  // same way a bounced email does), so no try/catch is needed here either.
  const pushRecipientIds = await pushService.resolveUserIdsByRole(orgId, ['owner']);
  if (salesRep?.users?.id) pushRecipientIds.push(salesRep.users.id);
  await pushService.notify(orgId, pushRecipientIds, {
    title: 'Payment received',
    body: `${naira(payment.amount)} from ${customer.full_name || 'a buyer'}`,
    url: '/#/payments',
  });

  // SECTION 20 — the buyer's own portal bell, separate from the staff push
  // above: the recipient, the channel and the wording are all different,
  // which is why this is its own call rather than folded into the one above.
  await portalNotifications.notify(orgId, customer.id, 'payment_recorded',
    'Payment received', `We received ${naira(payment.amount)}. Thank you!`);

  featureUsage.track(orgId, 'payment_recorded');

  // ── History ──────────────────────────────────────────────────────────────
  await auditSystem({
    orgId,
    actorKind: source === 'paystack' ? 'paystack' : source === 'portal' ? 'portal' : 'user',
    actorEmail: actor?.email || null,
    action: 'payment.recorded',
    entityType: 're_payments',
    entityId: paymentId,
    summary: `${naira(payment.amount)} received from ${customer.full_name || 'buyer'} `
      + `for installment ${schedule.installment_number} (${payment.method})`
      // Named in the summary, not buried in metadata: an unexplained credit is
      // exactly the fact somebody will come looking for in this log.
      + (outcome.overpayment > 0 ? ` — ${naira(outcome.overpayment)} OVER the amount due` : ''),
    metadata: {
      source,
      amount: Number(payment.amount),
      method: payment.method,
      reference: payment.paystack_reference || null,
      schedule_id: schedule.id,
      reservation_id: reservation.id,
      receipt: outcome.receipt,
      commission: outcome.commission,
      overpayment: outcome.overpayment || undefined,
    },
    // FEATURE — system log with undo. Undoing a recorded payment means
    // voiding it — undoService.js calls the exact same voidPayment()
    // paystackService already exposes for a manual void, so this needs
    // nothing beyond the ids that already identify what to void.
    reversible: true,
    reversalData: { payment_id: paymentId, commission_id: accrual.accrued ? accrual.commission.id : null },
  });

  return outcome;
}

// Idempotent on reservation.status: a webhook retry or a second call finding
// the reservation already 'completed' does nothing further, same reasoning
// as every other step in this file being safe to run more than once.
async function completeOutrightSale({ orgId, reservation, unit, source, actor }) {
  if (reservation.status === 'completed') return;

  // One allocation letter per reservation is a database-enforced rule
  // (migrations/005's partial unique index) — checked here first, the same
  // way routes/documents.js's bulk-generate checks superseded_at is null,
  // so a payment retried after a successful first run never tries to
  // insert a second live letter for the same reservation.
  const { data: existingDoc } = await supabaseAdmin
    .from('re_documents')
    .select('id')
    .eq('organization_id', orgId)
    .eq('reservation_id', reservation.id)
    .eq('doc_type', 'allocation_letter')
    .is('superseded_at', null)
    .maybeSingle();

  if (!existingDoc) {
    try {
      const { data: doc, error } = await supabaseAdmin
        .from('re_documents')
        .insert({ organization_id: orgId, reservation_id: reservation.id, doc_type: 'allocation_letter' })
        .select('id')
        .single();
      if (error) throw error;
      await generateDocument(orgId, doc.id);
    } catch (err) {
      // A failed render must not stop the reservation from completing — the
      // sale happened; the letter can be regenerated by hand from Documents.
      console.warn('[payment-events] outright allocation letter failed:', err.message);
    }
  }

  await supabaseAdmin
    .from('re_reservations')
    .update({ status: 'completed' })
    .eq('id', reservation.id)
    .eq('organization_id', orgId)
    .neq('status', 'completed');

  if (unit?.id) {
    await supabaseAdmin
      .from('re_units')
      .update({ status: 'sold' })
      .eq('id', unit.id)
      .eq('organization_id', orgId);
  }

  await auditSystem({
    orgId,
    actorKind: source === 'paystack' ? 'paystack' : source === 'portal' ? 'portal' : 'user',
    actorEmail: actor?.email || null,
    action: 'reservation.completed',
    entityType: 're_reservations',
    entityId: reservation.id,
    summary: 'Outright sale paid in full — reservation completed and allocation letter generated automatically',
    metadata: { property_type: 'outright', unit_id: unit?.id || null },
  });
}

function nextDueBlock(context) {
  if (context.balance <= 0) {
    return '<p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#1f6b3c"><strong>This plan is now fully paid.</strong> Your allocation documents will follow.</p>';
  }
  return '<p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#3c3c3c">'
    + escapeHtml(`Thank you. ${naira(context.balance)} remains on this plan.`)
    + '</p>';
}

async function safeContext(orgId, paymentId) {
  try {
    return await receipts.loadPaymentContext(orgId, paymentId);
  } catch (err) {
    console.warn('[payment-events] could not load payment context:', err.message);
    return null;
  }
}

async function orgSettings(orgId) {
  try {
    const { data } = await supabaseAdmin
      .from('re_org_settings')
      .select('company_name, notify_on_payment, notify_on_overdue, notify_md_email, reply_to_email')
      .eq('organization_id', orgId)
      .maybeSingle();
    return data || {};
  } catch {
    return {};
  }
}

// Escalation only ever winds DOWN here. Winding it up is the morning sweep's
// job (escalationService), which sees the whole picture rather than one
// payment's worth of it.
//
// Scoped to the RESERVATION, not the one plan the just-recorded payment
// landed on — matching escalationService.sweepEscalations's own scope
// exactly. A rental renewal deliberately leaves the OLD plan's unpaid rows
// untouched (rentalService.renewTenancy — "carries forward nothing... paid
// rows and the whole prior schedule are left exactly as they were"), so a
// genuinely still-overdue rent installment on a now-superseded plan must
// still block de-escalation here; checking only the current plan would let
// paying the first installment of a fresh lease term silently clear an
// escalation that real arrears on the old term still justify. Restructuring
// costs this nothing in the other direction — it WAIVES the old plan's
// unpaid rows, and a waived row is never 'overdue'.
async function maybeDeescalate(orgId, reservationId) {
  try {
    const { data: stillOverdue } = await supabaseAdmin
      .from('re_installment_schedule')
      .select('id, re_installment_plans!inner(reservation_id)')
      .eq('organization_id', orgId)
      .eq('re_installment_plans.reservation_id', reservationId)
      .eq('status', 'overdue')
      .limit(1);

    if (stillOverdue?.length) return;

    await supabaseAdmin
      .from('re_reservations')
      .update({ escalation_stage: 'none', escalated_at: null })
      .eq('id', reservationId)
      .eq('organization_id', orgId)
      .neq('escalation_stage', 'none');
  } catch (err) {
    console.warn('[payment-events] could not de-escalate:', err.message);
  }
}

module.exports = { onPaymentRecorded, naira, formatDate };
