// routes/audit.js — reading the record. There is no route that writes it from
// a client, and no route that edits or deletes it at all: a log the operator
// can alter is not evidence, and evidence is the point (see auditService).

const express = require('express');
const { supabaseAdmin, requireRole } = require('../middleware/orgContext');
const router = express.Router();

router.get('/', requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    let query = supabaseAdmin
      .from('re_audit_log')
      .select('*')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (req.query.action) query = query.eq('action', req.query.action);
    if (req.query.entity_type) query = query.eq('entity_type', req.query.entity_type);
    if (req.query.entity_id) query = query.eq('entity_id', req.query.entity_id);
    if (req.query.actor_id) query = query.eq('actor_id', req.query.actor_id);
    if (req.query.from) query = query.gte('created_at', req.query.from);
    if (req.query.to) query = query.lte('created_at', req.query.to);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Everything that ever happened to one record — the query an actual dispute
// starts with: "show me this reservation's history".
router.get('/entity/:type/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_audit_log')
      .select('*')
      .eq('organization_id', req.orgId)
      .eq('entity_type', req.params.type)
      .eq('entity_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// The notification outbox lives here rather than under its own prefix because
// it answers the same question in a different register: not "who did this"
// but "what did we actually send the buyer, and did it arrive".
router.get('/notifications', requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_notifications')
      .select('*')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(req.query.limit) || 100, 500));

    if (req.query.channel) query = query.eq('channel', req.query.channel);
    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
