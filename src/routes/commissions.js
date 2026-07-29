const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { summaryByRep, repPerformance } = require('../services/commissionService');
const { audit } = require('../services/auditService');
const router = express.Router();

const COMMISSION_STATUSES = ['accrued', 'approved', 'paid', 'void'];

// The month-end screen: what each rep earned, what is still owed them, what
// has been paid out. This is the spreadsheet the admin team currently keeps
// by hand and reconciles against the payment log line by line.
router.get('/summary', async (req, res, next) => {
  try {
    res.json(await summaryByRep(req.orgId, {
      from: req.query.from || null,
      to: req.query.to || null,
    }));
  } catch (e) { next(e); }
});

// Line by line, so a rep who disagrees with their total can be shown exactly
// which payments it came from.
router.get('/', async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_commissions')
      .select(`
        *,
        re_sales_reps(id, users(full_name, email)),
        re_payments(amount, method, paid_at, paystack_reference),
        re_reservations(
          re_customers(full_name),
          re_units(unit_number, re_projects(name))
        )`)
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(req.query.limit) || 200, 500));

    if (req.query.sales_rep_id) query = query.eq('sales_rep_id', req.query.sales_rep_id);
    if (req.query.status) {
      if (!COMMISSION_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status must be one of: ${COMMISSION_STATUSES.join(', ')}` });
      }
      query = query.eq('status', req.query.status);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Payout runs move many rows at once, so this takes a list. Approving and
// paying are separate states because in practice they are separate people:
// a sales director approves, finance pays.
router.patch('/status', async (req, res, next) => {
  try {
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    if (!COMMISSION_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${COMMISSION_STATUSES.join(', ')}` });
    }

    const updates = { status };
    if (status === 'paid') updates.paid_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('re_commissions')
      .update(updates)
      .in('id', ids)
      .eq('organization_id', req.orgId)
      .select('id, amount, sales_rep_id');
    if (error) throw error;

    const total = (data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    audit(req, {
      action: `commission.${status}`,
      entityType: 're_commissions',
      summary: `${data.length} commission entries marked ${status} — ₦${total.toLocaleString('en-NG')}`,
      metadata: { ids: data.map((r) => r.id), status, total },
    });

    res.json({ updated: data.length, total, entries: data });
  } catch (e) { next(e); }
});

// Sales rep performance. Every number here was already in the database; it had
// simply never been put on a page a sales director could open.
router.get('/performance', async (req, res, next) => {
  try {
    res.json(await repPerformance(req.orgId));
  } catch (e) { next(e); }
});

module.exports = router;
