const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const router = express.Router();

const PROJECT_STATUSES = ['planning', 'active', 'sold_out', 'archived'];

router.get('/', requirePermission('inventory.read'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_projects')
      .select('*, re_units(status)')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Unit counts come back with the projects so the list screen doesn't need
    // a follow-up request per project.
    const projects = (data || []).map(({ re_units, ...project }) => ({
      ...project,
      units_total: re_units.length,
      units_sold: re_units.filter((u) => u.status === 'sold').length,
      units_reserved: re_units.filter((u) => u.status === 'reserved').length,
      units_available: re_units.filter((u) => u.status === 'available').length,
    }));

    res.json(projects);
  } catch (e) { next(e); }
});

router.post('/', requirePermission('inventory.write'), async (req, res, next) => {
  try {
    const { name, location, total_units, status } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (status && !PROJECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${PROJECT_STATUSES.join(', ')}` });
    }

    const { data, error } = await supabaseAdmin
      .from('re_projects')
      .insert({
        organization_id: req.orgId,
        name,
        location: location || null,
        total_units: total_units ?? null,
        status: status || 'active',
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.patch('/:id', requirePermission('inventory.write'), async (req, res, next) => {
  try {
    const { name, location, total_units, status } = req.body || {};
    if (status && !PROJECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${PROJECT_STATUSES.join(', ')}` });
    }

    // Only send the fields the caller actually supplied — spreading undefined
    // over a partial update would blank columns they never mentioned.
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (location !== undefined) updates.location = location;
    if (total_units !== undefined) updates.total_units = total_units;
    if (status !== undefined) updates.status = status;
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_projects')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Project not found' });
    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
