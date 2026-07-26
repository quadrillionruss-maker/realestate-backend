const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { initInstallmentPayment, recordManualPayment } = require('../services/paystackService');
const router = express.Router();

const PAYMENT_METHODS = ['paystack', 'bank_transfer', 'cash', 'pos'];

// Most recent first. Capped rather than paginated for v1 — a developer with
// 500 buyers reviews this month's money, not three years of it.
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const { data, error } = await supabaseAdmin
      .from('re_payments')
      .select('*, re_installment_schedule(installment_number, due_date, amount_due, status, re_installment_plans(re_reservations(re_customers(full_name), re_units(unit_number, re_projects(name)))))')
      .eq('organization_id', req.orgId)
      .order('paid_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Paystack link for one installment, charging whatever is still outstanding.
router.post('/:scheduleId/init', async (req, res, next) => {
  try {
    const { customer_email } = req.body || {};
    if (!customer_email) return res.status(400).json({ error: 'customer_email is required' });

    const result = await initInstallmentPayment(req.orgId, req.params.scheduleId, customer_email);
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
    res.status(201).json(payment);
  } catch (e) { next(e); }
});

module.exports = router;
