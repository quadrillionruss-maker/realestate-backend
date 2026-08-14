// routes/legalCases.js — Legal and Recovery, SECTION 8. Thin HTTP layer;
// see src/services/legalCaseService.js for what opening/updating a case
// actually does.
const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const legal = require('../services/legalCaseService');
const router = express.Router();

router.get('/', requirePermission('legal.read'), async (req, res, next) => {
  try {
    const status = legal.STATUSES.includes(req.query.status) ? req.query.status : null;
    res.json(await legal.listCases(req.orgId, status));
  } catch (e) { next(e); }
});

router.get('/summary', requirePermission('legal.read'), async (req, res, next) => {
  try {
    res.json(await legal.summary(req.orgId));
  } catch (e) { next(e); }
});

router.get('/:id', requirePermission('legal.read'), async (req, res, next) => {
  try {
    const data = await legal.getCase(req.orgId, req.params.id);
    if (!data) return res.status(404).json({ error: 'Legal case not found' });
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/', requirePermission('legal.manage'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await legal.openCase(req, {
      customerId: body.customer_id,
      reservationId: body.reservation_id,
      lawyerName: body.lawyer_name,
      lawyerPhone: body.lawyer_phone,
      lawyerEmail: body.lawyer_email,
      notes: body.notes,
    });
    if (result.notFound) return res.status(404).json({ error: 'Reservation not found for this customer' });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.patch('/:id', requirePermission('legal.manage'), async (req, res, next) => {
  try {
    const result = await legal.updateCase(req, req.params.id, req.body || {});
    if (result.notFound) return res.status(404).json({ error: 'Legal case not found' });
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
