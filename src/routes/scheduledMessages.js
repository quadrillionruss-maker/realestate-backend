// routes/scheduledMessages.js — SECTION 16. Same tier as logging a call or
// visit (permissions.js's activities.write): scheduling a WhatsApp message
// is a communication action any operational role who talks to buyers may
// take, not a workspace-configuration decision.

const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const scheduledMessages = require('../services/scheduledMessageService');
const { audit } = require('../services/auditService');
const router = express.Router();

router.get('/', requirePermission('activities.write'), async (req, res, next) => {
  try {
    if (!req.query.customer_id) {
      return res.status(400).json({ error: 'customer_id is required.' });
    }
    res.json(await scheduledMessages.listForCustomer(req.orgId, req.query.customer_id));
  } catch (e) { next(e); }
});

router.post('/', requirePermission('activities.write'), async (req, res, next) => {
  try {
    const data = await scheduledMessages.schedule(req.orgId, {
      customerId: req.body?.customer_id,
      message: req.body?.message,
      scheduledFor: req.body?.scheduled_for,
      createdBy: req.userId,
    });

    audit(req, {
      action: 'scheduled_message.created',
      entityType: 're_scheduled_messages',
      entityId: data.id,
      summary: `WhatsApp message scheduled for ${data.scheduled_for}`,
    });

    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.delete('/:id', requirePermission('activities.write'), async (req, res, next) => {
  try {
    await scheduledMessages.cancel(req.orgId, req.params.id);

    audit(req, {
      action: 'scheduled_message.cancelled',
      entityType: 're_scheduled_messages',
      entityId: req.params.id,
      summary: 'Scheduled message cancelled',
    });

    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
