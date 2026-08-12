const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission, assertPermission, isOwnRecordsOnly, salesRepIdsFor, MATCHES_NOTHING } = require('../middleware/rbac');
const { summaryByRep, repPerformance } = require('../services/commissionService');
const { audit } = require('../services/auditService');
const router = express.Router();

const COMMISSION_STATUSES = ['accrued', 'approved', 'paid', 'void'];

// The month-end screen: what each rep earned, what is still owed them, what
// has been paid out. Owner and Sales Director only — a rep sees their own
// lines through GET / below, never the whole team's totals.
router.get('/summary', requirePermission('commissions.readAll'), async (req, res, next) => {
  try {
    res.json(await summaryByRep(req.orgId, {
      from: req.query.from || null,
      to: req.query.to || null,
    }));
  } catch (e) { next(e); }
});

// Line by line, so a rep who disagrees with their total can be shown exactly
// which payments it came from. A sales rep sees only their own — everyone
// else who can open this screen at all sees the whole team's.
router.get('/', requirePermission('commissions.read'), async (req, res, next) => {
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

    if (isOwnRecordsOnly(req.orgRole)) {
      const repIds = await salesRepIdsFor(req);
      query = query.in('sales_rep_id', repIds.length ? repIds : [MATCHES_NOTHING]);
    } else if (req.query.sales_rep_id) {
      query = query.eq('sales_rep_id', req.query.sales_rep_id);
    }

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
// paying are separate states because in practice they are separate people —
// and separate roles: a sales director approves, only the owner pays.
router.patch('/status', async (req, res, next) => {
  try {
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    if (!COMMISSION_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${COMMISSION_STATUSES.join(', ')}` });
    }

    // What matters for permission is not just the TARGET status but whether
    // any targeted row is CURRENTLY 'paid' — moving one back to accrued or
    // void undoes an owner-only action (a payout actually made), and doing
    // that must require the same tier as making the payment in the first
    // place. Without this, a Sales Director could pick 'accrued' or 'void'
    // as the target and the old target-only check would apply the lower
    // commissions.approve bar to what is really reversing a payout.
    const { data: currentRows, error: currentErr } = await supabaseAdmin
      .from('re_commissions')
      .select('id, status')
      .in('id', ids)
      .eq('organization_id', req.orgId);
    if (currentErr) throw currentErr;

    const anyCurrentlyPaid = (currentRows || []).some((row) => row.status === 'paid');
    // Which permission applies depends on what was posted — and now, on what
    // is already true of the targeted rows — not the path, so this can't be
    // a route-level requirePermission — see rbac.js.
    const action = (status === 'paid' || anyCurrentlyPaid) ? 'commissions.markPaid' : 'commissions.approve';
    if (!assertPermission(req, res, action)) return;

    const updates = { status };
    if (status === 'paid') {
      updates.paid_at = new Date().toISOString();
    } else if (anyCurrentlyPaid) {
      // A row moving OFF 'paid' to something else must not keep a stale
      // paid_at — it is no longer true this commission was paid on that
      // date, and a leftover timestamp would read as "paid" to any report
      // that trusts the column instead of the status.
      updates.paid_at = null;
    }

    const { data, error } = await supabaseAdmin
      .from('re_commissions')
      .update(updates)
      .in('id', ids)
      .eq('organization_id', req.orgId)
      // The update path is not covered by orgContext's automatic soft-delete
      // filter (that only wraps .select()) — without this, the update could
      // match a soft-deleted commission row (e.g. cascaded from a deleted
      // buyer) and mark it paid, while it stays invisible everywhere else.
      .is('deleted_at', null)
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

// Sales rep performance across the whole team. Same tier as the summary
// screen above — a rep sees their own numbers, never a table ranking them
// against everyone else.
router.get('/performance', requirePermission('commissions.readAll'), async (req, res, next) => {
  try {
    res.json(await repPerformance(req.orgId));
  } catch (e) { next(e); }
});

module.exports = router;
