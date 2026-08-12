const express = require('express');
const promises = require('../services/promiseService');
const { audit } = require('../services/auditService');
const { requirePermission } = require('../middleware/rbac');
const router = express.Router();

// Every promise a buyer has made, oldest date first — the order a rep works
// through them. `?status=open` is the morning list; `?status=broken` is the
// conversation nobody enjoys but everybody needs to have.
router.get('/', requirePermission('promises.read'), async (req, res, next) => {
  try {
    // Unlike every sibling list route (payments.js, reservations.js), this one
    // had no cap at all, risking an unbounded response and silent truncation
    // past PostgREST's own max-rows setting. promiseService.listPromises does
    // not accept a query-level limit (it lives outside this route file), so
    // the cap is applied here on the response instead — same ceiling shape
    // (`?limit=`, capped) as the other list routes use at the query level.
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const data = await promises.listPromises(req.orgId, {
      status: req.query.status || null,
      scheduleId: req.query.schedule_id || null,
      customerId: req.query.customer_id || null,
    });
    res.json(data.slice(0, limit));
  } catch (e) { next(e); }
});

// Logged from the at-risk list while the rep still has the buyer on the phone.
// Anything that takes longer than the call itself will not get filled in.
router.post('/', requirePermission('promises.write'), async (req, res, next) => {
  try {
    const { schedule_id, promised_date, promised_amount, spoke_to, notes } = req.body || {};

    const result = await promises.logPromise(req.orgId, {
      scheduleId: schedule_id,
      promisedDate: promised_date,
      promisedAmount: promised_amount,
      spokeTo: spoke_to,
      notes,
      loggedBy: req.userId,
    });

    audit(req, {
      action: 'promise.logged',
      entityType: 're_payment_promises',
      entityId: result.promise.id,
      summary: `Promised ${promised_amount ? `₦${Number(promised_amount).toLocaleString('en-NG')}` : 'payment'} by ${promised_date}`,
      metadata: { schedule_id, promised_date, spoke_to: spoke_to || null, superseded: result.superseded },
    });

    res.status(201).json(result.promise);
  } catch (e) { next(e); }
});

// Manual resolution, for the cases the sweep cannot see: paid in cash at the
// office, or a promise withdrawn on a second call.
router.patch('/:id/status', requirePermission('promises.write'), async (req, res, next) => {
  try {
    const promise = await promises.resolvePromise(req.orgId, req.params.id, req.body?.status);
    if (!promise) return res.status(404).json({ error: 'Promise not found' });

    audit(req, {
      action: `promise.${req.body.status}`,
      entityType: 're_payment_promises',
      entityId: req.params.id,
      summary: `Promise marked ${req.body.status}`,
    });

    res.json(promise);
  } catch (e) { next(e); }
});

module.exports = router;
