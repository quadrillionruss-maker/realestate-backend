const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { initInstallmentPayment, recordManualPayment } = require('../services/paystackService');
const { onPaymentRecorded } = require('../services/paymentEvents');
const { generateReceipt } = require('../services/receiptService');
const { getDownloadUrl } = require('../services/documentService');
const { audit } = require('../services/auditService');
const router = express.Router();

const PAYMENT_METHODS = ['paystack', 'bank_transfer', 'cash', 'pos'];
const SCHEDULE_STATUSES = ['pending', 'paid', 'overdue', 'waived'];

// Most recent first. Capped rather than paginated for v1 — a developer with
// 500 buyers reviews this month's money, not three years of it.
router.get('/', async (req, res, next) => {
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
    if (req.query.to) query = query.lte('paid_at', req.query.to);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// The installment schedule itself — what a "record a payment" screen is
// actually browsing. Before this existed, the only way to find the schedule id
// you needed was to open a customer and read it out of their nested history,
// which is why recording a payment required Postman.
router.get('/schedule', async (req, res, next) => {
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
        .from('re_payments').select('schedule_id, amount').in('schedule_id', ids);
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
router.post('/:scheduleId/init', async (req, res, next) => {
  try {
    const { customer_email } = req.body || {};
    if (!customer_email) return res.status(400).json({ error: 'customer_email is required' });

    const result = await initInstallmentPayment(req.orgId, req.params.scheduleId, customer_email);

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
router.post('/:scheduleId/record', async (req, res, next) => {
  try {
    const { amount, method, reference } = req.body || {};
    if (amount == null) return res.status(400).json({ error: 'amount is required' });
    if (method && !PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: `method must be one of: ${PAYMENT_METHODS.join(', ')}` });
    }

    const payment = await recordManualPayment(req.orgId, req.params.scheduleId, { amount, method, reference });

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
    });

    res.status(201).json({ ...payment, effects });
  } catch (e) { next(e); }
});

// Re-render a receipt. Idempotent — it writes back to the same document row
// and the same storage path — so this doubles as "the buyer lost it, send it
// again" without producing a second receipt for one payment.
router.post('/:id/receipt', async (req, res, next) => {
  try {
    const result = await generateReceipt(req.orgId, req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Payment not found' });

    audit(req, {
      action: 'receipt.generated',
      entityType: 're_payments',
      entityId: req.params.id,
      summary: `Receipt ${result.receipt_number} generated`,
      metadata: { document_id: result.document.id },
    });

    res.json({
      document: result.document,
      download_url: result.download_url,
      receipt_number: result.receipt_number,
    });
  } catch (e) { next(e); }
});

router.get('/:id/receipt', async (req, res, next) => {
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
