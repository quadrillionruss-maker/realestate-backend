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

  // ── Commission ───────────────────────────────────────────────────────────
  const accrual = await commissions.accrueForPayment({ orgId, payment, reservation, salesRep });
  outcome.commission = accrual.accrued ? `accrued ${naira(accrual.commission.amount)}` : accrual.reason;

  // ── Tell the buyer ───────────────────────────────────────────────────────
  const settings = await orgSettings(orgId);
  if (settings.notify_on_payment !== false) {
    const projectLine = [project.name, unit.unit_number && `Unit ${unit.unit_number}`]
      .filter(Boolean).join(' · ');

    if (customer.email) {
      const html = notify.emailShell({
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

      const result = await notify.sendEmail({
        orgId,
        to: customer.email,
        subject: `Receipt for ${naira(payment.amount)} — ${projectLine || 'your purchase'}`,
        html,
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
    await maybeDeescalate(orgId, reservation.id, plan.id);
  }

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
  });

  return outcome;
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
async function maybeDeescalate(orgId, reservationId, planId) {
  try {
    const { data: stillOverdue } = await supabaseAdmin
      .from('re_installment_schedule')
      .select('id')
      .eq('organization_id', orgId)
      .eq('plan_id', planId)
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
