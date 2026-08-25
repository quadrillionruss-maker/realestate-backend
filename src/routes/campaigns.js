// routes/campaigns.js — SECTION 11 (feature expansion). Reading the list is
// campaigns.read (DIRECTORS); creating, editing and sending is
// campaigns.write/campaigns.send (OWNER) — see permissions.js's own
// comment for why a bulk send sits at that tier.
const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const { audit } = require('../services/auditService');
const campaigns = require('../services/campaignService');
const router = express.Router();

router.get('/', requirePermission('campaigns.read'), async (req, res, next) => {
  try {
    res.json(await campaigns.list(req.orgId));
  } catch (e) { next(e); }
});

router.post('/', requirePermission('campaigns.write'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const created = await campaigns.create(req, {
      name: body.name, type: body.type, message_body: body.message_body, target_filter: body.target_filter,
    });

    audit(req, {
      action: 'campaign.created',
      entityType: 're_campaigns',
      entityId: created.id,
      summary: `Campaign "${created.name}" created (${created.type})`,
      metadata: { type: created.type, target_filter: created.target_filter },
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

// The "preview the recipient list" step — no id yet, since a draft is
// previewed before it is even saved, same reasoning
// reservations/plan-recommendation is its own route ahead of POST /.
router.post('/preview-audience', requirePermission('campaigns.write'), async (req, res, next) => {
  try {
    res.json(await campaigns.previewAudience(req.orgId, req.body?.target_filter));
  } catch (e) { next(e); }
});

router.get('/:id', requirePermission('campaigns.read'), async (req, res, next) => {
  try {
    const campaign = await campaigns.get(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  } catch (e) { next(e); }
});

router.get('/:id/deliveries', requirePermission('campaigns.read'), async (req, res, next) => {
  try {
    const result = await campaigns.deliveries(req.orgId, req.params.id);
    if (!result) return res.status(404).json({ error: 'Campaign not found' });
    res.json(result);
  } catch (e) { next(e); }
});

router.patch('/:id', requirePermission('campaigns.write'), async (req, res, next) => {
  try {
    const updated = await campaigns.update(req.orgId, req.params.id, req.body || {});
    if (updated.notFound) return res.status(404).json({ error: 'Campaign not found' });

    audit(req, {
      action: 'campaign.updated',
      entityType: 're_campaigns',
      entityId: req.params.id,
      summary: `Campaign "${updated.name}" updated`,
    });

    res.json(updated);
  } catch (e) { next(e); }
});

router.post('/:id/send', requirePermission('campaigns.send'), async (req, res, next) => {
  try {
    const result = await campaigns.send(req, req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Campaign not found' });

    audit(req, {
      action: 'campaign.sent',
      entityType: 're_campaigns',
      entityId: req.params.id,
      summary: `Campaign "${result.name}" sent — ${result.sent_count} sent, ${result.failed_count} failed`,
      metadata: { sent: result.sent_count, failed: result.failed_count },
    });

    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
