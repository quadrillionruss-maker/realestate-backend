// routes/logs.js — the daily log book, SECTION 3 (feature expansion).
//
// Free-text incident/update/communication/decision/visitor notes against the
// workspace or one of its projects. Not restricted by role (permissions.js's
// logs.read/logs.write are ALL) — the same "anyone who works here can write
// one down" spirit as re_tasks and re_activities.
const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const router = express.Router();

const ENTRY_TYPES = ['incident', 'update', 'communication', 'decision', 'visitor'];

router.get('/', requirePermission('logs.read'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_log_entries')
      .select('*, users(full_name, email), re_projects(name)')
      .eq('organization_id', req.orgId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500);

    if (req.query.project_id) query = query.eq('project_id', req.query.project_id);
    if (req.query.entry_type) {
      if (!ENTRY_TYPES.includes(req.query.entry_type)) {
        return res.status(400).json({ error: `entry_type must be one of: ${ENTRY_TYPES.join(', ')}` });
      }
      query = query.eq('entry_type', req.query.entry_type);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { next(e); }
});

router.post('/', requirePermission('logs.write'), async (req, res, next) => {
  try {
    const { entry_type, content, project_id = null } = req.body || {};
    if (!entry_type || !content || !content.trim()) {
      return res.status(400).json({ error: 'entry_type and content are required' });
    }
    if (!ENTRY_TYPES.includes(entry_type)) {
      return res.status(400).json({ error: `entry_type must be one of: ${ENTRY_TYPES.join(', ')}` });
    }

    if (project_id) {
      const { data: project } = await supabaseAdmin
        .from('re_projects').select('id').eq('id', project_id).eq('organization_id', req.orgId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_log_entries')
      .insert({
        organization_id: req.orgId, user_id: req.userId, project_id,
        entry_type, content: content.trim(),
      })
      .select('*, users(full_name, email), re_projects(name)')
      .single();
    if (error) throw error;

    res.status(201).json(data);
  } catch (e) { next(e); }
});

module.exports = router;
