const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const router = express.Router();

const UNIT_STATUSES = ['available', 'reserved', 'sold'];
const MAX_BULK_UNITS = 500;

const assertProjectInOrg = async (projectId, orgId) => {
  const { data } = await supabaseAdmin
    .from('re_projects').select('id')
    .eq('id', projectId).eq('organization_id', orgId).maybeSingle();
  return Boolean(data);
};

router.get('/', async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_units')
      .select('*, re_projects(name)')
      .eq('organization_id', req.orgId)
      .order('unit_number');

    if (req.query.project_id) query = query.eq('project_id', req.query.project_id);
    if (req.query.status) {
      if (!UNIT_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status must be one of: ${UNIT_STATUSES.join(', ')}` });
      }
      query = query.eq('status', req.query.status);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { project_id, unit_number, unit_type, size_sqm, list_price } = req.body || {};
    if (!project_id || !unit_number || list_price == null) {
      return res.status(400).json({ error: 'project_id, unit_number and list_price are required' });
    }
    if (!(await assertProjectInOrg(project_id, req.orgId))) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_units')
      .insert({
        organization_id: req.orgId,
        project_id,
        unit_number,
        unit_type: unit_type || null,
        size_sqm: size_sqm ?? null,
        list_price,
      })
      .select()
      .single();

    // 23505 = the (project_id, unit_number) uniqueness constraint.
    if (error?.code === '23505') {
      return res.status(409).json({ error: `Unit "${unit_number}" already exists in this project` });
    }
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// Bulk create — how a project's inventory actually gets entered: one paste of
// 40 units, not 40 form submissions.
router.post('/bulk', async (req, res, next) => {
  try {
    const { project_id, units } = req.body || {};
    if (!project_id || !Array.isArray(units) || !units.length) {
      return res.status(400).json({ error: 'project_id and a non-empty units[] are required' });
    }
    if (units.length > MAX_BULK_UNITS) {
      return res.status(400).json({ error: `Cannot create more than ${MAX_BULK_UNITS} units in one request` });
    }
    if (!(await assertProjectInOrg(project_id, req.orgId))) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Validate the whole batch before inserting any of it, and report the
    // offending row by index — "units[7] is missing list_price" is actionable,
    // "insert failed" is not.
    const rows = [];
    for (const [index, unit] of units.entries()) {
      if (!unit || !unit.unit_number || unit.list_price == null) {
        return res.status(400).json({ error: `units[${index}] requires unit_number and list_price` });
      }
      rows.push({
        organization_id: req.orgId,
        project_id,
        unit_number: unit.unit_number,
        unit_type: unit.unit_type || null,
        size_sqm: unit.size_sqm ?? null,
        list_price: unit.list_price,
      });
    }

    const duplicates = rows.map((r) => r.unit_number)
      .filter((value, index, all) => all.indexOf(value) !== index);
    if (duplicates.length) {
      return res.status(400).json({ error: `Duplicate unit numbers in request: ${[...new Set(duplicates)].join(', ')}` });
    }

    const { data, error } = await supabaseAdmin.from('re_units').insert(rows).select();
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'One or more unit numbers already exist in this project' });
    }
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

module.exports = router;
