const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const { initInstallmentPayment, recordManualPayment, reallocateOverpayment, voidPayment } = require('../services/paystackService');
const { onPaymentRecorded } = require('../services/paymentEvents');
const { generateReceipt } = require('../services/receiptService');
const { getDownloadUrl } = require('../services/documentService');
const { audit } = require('../services/auditService');
const router = express.Router();

const PAYMENT_METHODS = ['paystack', 'bank_transfer', 'cash', 'pos'];
const SCHEDULE_STATUSES = ['pending', 'paid', 'overdue', 'waived'];

// Most recent first. Capped rather than paginated for v1 — a developer with
// 500 buyers reviews this month's money, not three years of it.
router.get('/', requirePermission('payments.read'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    let query = supabaseAdmin
      .from('re_payments')
      .select('*, re_installment_schedule(installment_number, due_date, amount_due, status, re_installment_plans(re_reservations(re_customers(full_name), re_units(unit_number, re_projects(name)))))')
      .eq('organization_id', req.orgId)
      .order('paid_at', { ascending: false })
      .limit(limit);

    if (req.query.method) query = query.eq('method', req.query.method);
    if (req.query.from) query = query.gte('paid_at', req.query.from);
    if (req.query.to) {
      // paid_at is a timestamptz. A bare "YYYY-MM-DD" is a calendar day, not
      // an instant — lte against it means <= midnight, which excludes every
      // payment made later that same day, i.e. nearly all of them. Advance to
      // the start of the next day and use lt so "to 30 Jul" actually includes
      // 30 Jul. A caller that already passed a full timestamp is trusted as-is.
      if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
        const nextDay = new Date(`${req.query.to}T00:00:00.000Z`);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        query = query.lt('paid_at', nextDay.toISOString());
      } else {
        query = query.lte('paid_at', req.query.to);
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// The installment schedule itself — what a "record a payment" screen is
// actually browsing. Before this existed, the only way to find the schedule id
// you needed was to open a customer and read it out of their nested history,
// which is why recording a payment required Postman.
router.get('/schedule', requirePermission('payments.schedule'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_installment_schedule')
      .select(`
        id, installment_number, due_date, amount_due, status, paid_at, plan_id,
        re_installment_plans!inner(
          id, reservation_id, total_amount, number_of_installments,
          re_reservations!inner(
            id, status, escalation_stage,
            re_customers(id, full_name, phone, email),
            re_units(unit_number, re_projects(id, name))
          )
        )`)
      .eq('organization_id', req.orgId)
      .order('due_date', { ascending: true })
      .limit(Math.min(Number(req.query.limit) || 200, 1000));

    if (req.query.status) {
      if (!SCHEDULE_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status must be one of: ${SCHEDULE_STATUSES.join(', ')}` });
      }
      query = query.eq('status', req.query.status);
    }
    if (req.query.reservation_id) {
      query = query.eq('re_installment_plans.reservation_id', req.query.reservation_id);
    }
    if (req.query.customer_id) {
      query = query.eq('re_installment_plans.re_reservations.customer_id', req.query.customer_id);
    }
    if (req.query.due_before) query = query.lte('due_date', req.query.due_before);

    const { data, error } = await query;
    if (error) throw error;

    // How much of each installment is already covered. Partial payment is
    // normal here — a buyer sends ₦400k of a ₦500k due — and a screen that
    // cannot show it invites someone to record the ₦100k balance as a full one.
    const ids = (data || []).map((row) => row.id);
    const paidBySchedule = new Map();
    if (ids.length) {
      const { data: payments } = await supabaseAdmin
        .from('re_payments').select('schedule_id, amount').in('schedule_id', ids).is('voided_at', null);
      for (const payment of payments || []) {
        paidBySchedule.set(
          payment.schedule_id,
          (paidBySchedule.get(payment.schedule_id) || 0) + Number(payment.amount || 0)
        );
      }
    }

    res.json((data || []).map((row) => {
      const paid = paidBySchedule.get(row.id) || 0;
      return {
        ...row,
        amount_paid: paid,
        amount_outstanding: Math.max(0, Number(row.amount_due) - paid),
      };
    }));
  } catch (e) { next(e); }
});

// Paystack link for one installment, charging whatever is still outstanding.
router.post('/:scheduleId/init', requirePermission('payments.init'), async (req, res, next) => {
  try {
    const { customer_email } = req.body || {};
    if (!customer_email) return res.status(400).json({ error: 'customer_email is required' });

    // Same as routes/portal.js's own init call — without it, Paystack sends
    // the buyer to its own generic success page instead of back to their
    // portal, which is how a buyer talks themselves into paying twice on a
    // schedule row that still visually reads as unpaid.
    const env = require('../config/env');
    const callbackUrl = env.appUrl
      ? `${env.appUrl}/portal.html?paid=${encodeURIComponent(req.params.scheduleId)}`
      : null;

    const result = await initInstallmentPayment(req.orgId, req.params.scheduleId, customer_email, { callbackUrl });

    audit(req, {
      action: 'payment.initiated',
      entityType: 're_installment_schedule',
      entityId: req.params.scheduleId,
      summary: `Payment link generated for ₦${Number(result.amount).toLocaleString('en-NG')}`,
      metadata: { reference: result.reference, amount: result.amount, email: customer_email },
    });

    res.json(result);
  } catch (e) { next(e); }
});

// Offline payment: bank transfer, cash or POS. Bank transfer is how most
// Nigerian off-plan installments actually arrive, so this is not a fallback
// path — it is the common one.
router.post('/:scheduleId/record', requirePermission('payments.record'), async (req, res, next) => {
  try {
    const { amount, method, reference, payer_name } = req.body || {};
    if (amount == null) return res.status(400).json({ error: 'amount is required' });
    if (method && !PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: `method must be one of: ${PAYMENT_METHODS.join(', ')}` });
    }

    const payment = await recordManualPayment(req.orgId, req.params.scheduleId, {
      amount, method, reference, payerName: payer_name,
    });

    // Receipt, commission, buyer notification, promise resolution and the
    // audit entry — the same work a Paystack payment triggers, because which
    // door the money came through is not the buyer's concern. Awaited so the
    // response can tell the operator whether the buyer was actually emailed
    // rather than leaving them to guess.
    const effects = await onPaymentRecorded({
      orgId: req.orgId,
      paymentId: payment.id,
      source: 'manual',
      actor: req.user,
      overpayment: payment.overpayment,
    });

    res.status(201).json({ ...payment, effects });
  } catch (e) { next(e); }
});

// Moves an existing overpayment onto a different installment, without
// treating the credit as a second real-world transfer — see
// paystackService.reallocateOverpayment for why this is not just another
// call to /record.
router.post('/:paymentId/reallocate', requirePermission('payments.reallocate'), async (req, res, next) => {
  try {
    const { to_schedule_id } = req.body || {};
    if (!to_schedule_id) return res.status(400).json({ error: 'to_schedule_id is required' });

    const payment = await reallocateOverpayment(req.orgId, req.params.paymentId, to_schedule_id);

    // Same post-payment work as any other payment — a receipt and a buyer
    // notification are still correct here (the buyer should know their
    // credit was applied). Commission is not: commissionService recognizes
    // reallocated_from_payment_id and skips accrual on its own.
    const effects = await onPaymentRecorded({
      orgId: req.orgId,
      paymentId: payment.id,
      source: 'manual',
      actor: req.user,
      overpayment: payment.overpayment,
    });

    res.status(201).json({ ...payment, effects });
  } catch (e) { next(e); }
});

// Correcting a payment entered with the wrong amount — not a delete, and not
// an edit of the original row (see paystackService.voidPayment for why): the
// mistake stays visible, it just stops counting. Owner/Sales Director-gated
// for the same reason voiding stays at that tier and not collections': this
// is a direct, unilateral change to what a buyer is recorded as owing.
router.post('/:paymentId/void', requirePermission('payments.void'), async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required.' });

    const payment = await voidPayment(req.orgId, req.params.paymentId, reason);

    // The commission this payment earned, if any, was money that turns out
    // never to have arrived — void it too, rather than leaving a rep paid
    // (or owed) on a transfer that didn't happen.
    const { data: commission } = await supabaseAdmin
      .from('re_commissions')
      .update({ status: 'void' })
      .eq('payment_id', payment.id)
      .eq('organization_id', req.orgId)
      .neq('status', 'void')
      .select('id, amount')
      .maybeSingle();

    audit(req, {
      action: 'payment.voided',
      entityType: 're_payments',
      entityId: payment.id,
      summary: `₦${Number(payment.amount).toLocaleString('en-NG')} payment voided — ${reason}`
        + (commission ? `; commission of ₦${Number(commission.amount).toLocaleString('en-NG')} voided with it` : ''),
      metadata: {
        reason, amount: payment.amount, schedule_id: payment.schedule_id,
        commission_voided: commission?.id || null,
      },
    });

    res.json({ ...payment, commission_voided: Boolean(commission) });
  } catch (e) { next(e); }
});

// Writing off an installment the developer has decided not to collect — a
// goodwill gesture, a dispute settled another way, a bad debt finally
// accepted. Requires a reason: unlike a payment, there is no receipt behind
// this to explain later why the money stopped being owed. Owner only — even
// a Sales Director cannot write off debt.
router.patch('/:scheduleId/waive', requirePermission('payments.waive'), async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required.' });

    const { data: schedule, error: findErr } = await supabaseAdmin
      .from('re_installment_schedule')
      .select('id, status, amount_due, installment_number')
      .eq('id', req.params.scheduleId)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!schedule) return res.status(404).json({ error: 'Installment not found' });
    if (schedule.status === 'paid') {
      return res.status(409).json({ error: 'This installment is already paid — nothing to waive.' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_installment_schedule')
      .update({ status: 'waived' })
      .eq('id', req.params.scheduleId)
      .eq('organization_id', req.orgId)
      .select()
      .single();
    if (error) throw error;

    audit(req, {
      action: 'installment.waived',
      entityType: 're_installment_schedule',
      entityId: req.params.scheduleId,
      summary: `Installment ${schedule.installment_number} (₦${Number(schedule.amount_due).toLocaleString('en-NG')}) waived — ${reason}`,
      metadata: { reason, amount_due: schedule.amount_due, was_status: schedule.status },
    });

    res.json(data);
  } catch (e) { next(e); }
});

// Re-render a receipt. Idempotent — it writes back to the same document row,
// each render at its own versioned storage path — so this doubles as "the
// buyer lost it, send it again" without producing a second receipt for one
// payment, and without the earlier render's exact bytes being lost.
router.post('/:id/receipt', requirePermission('payments.receipt'), async (req, res, next) => {
  try {
    const result = await generateReceipt(req.orgId, req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Payment not found' });

    audit(req, {
      action: result.was_regeneration ? 'receipt.regenerated' : 'receipt.generated',
      entityType: 're_payments',
      entityId: req.params.id,
      summary: `Receipt ${result.receipt_number} ${result.was_regeneration ? 'regenerated' : 'generated'}`,
      metadata: {
        document_id: result.document.id,
        previous_storage_path: result.previous_storage_path || undefined,
      },
    });

    res.json({
      document: result.document,
      download_url: result.download_url,
      receipt_number: result.receipt_number,
    });
  } catch (e) { next(e); }
});

router.get('/:id/receipt', requirePermission('payments.receipt'), async (req, res, next) => {
  try {
    const { data: doc } = await supabaseAdmin
      .from('re_documents')
      .select('id, status')
      .eq('organization_id', req.orgId)
      .eq('payment_id', req.params.id)
      .eq('doc_type', 'receipt')
      .maybeSingle();

    if (!doc) return res.status(404).json({ error: 'No receipt has been generated for this payment yet.' });

    const result = await getDownloadUrl(req.orgId, doc.id);
    if (result.notGenerated) return res.status(409).json({ error: 'That receipt is still being generated.' });
    res.json({ ...result, document_id: doc.id });
  } catch (e) { next(e); }
});

module.exports = router;
