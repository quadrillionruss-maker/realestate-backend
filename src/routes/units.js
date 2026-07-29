const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { uploadMedia, MEDIA_TYPES, MAX_MEDIA_BYTES } = require('../services/documentStorage');
const { audit } = require('../services/auditService');
const router = express.Router();

const UNIT_STATUSES = ['available', 'reserved', 'sold'];
const MAX_BULK_UNITS = 500;

// metadata holds floor plans, photo URLs, a brochure link — whatever a
// developer wants to hang off a unit. jsonb rather than columns because every
// guess at what that list contains would be a migration.
//
// Two rules, both about a value that ends up inside a rendered document or an
// <img> in the browser: it must be an object, and any url-ish string in it
// must be https. A file: or data: URL here is a way to pull local content into
// a customer-facing page.
const MAX_METADATA_BYTES = 8 * 1024;

function sanitizeMetadata(metadata) {
  if (metadata == null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw Object.assign(new Error('metadata must be a JSON object'), { statusCode: 400 });
  }
  if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
    throw Object.assign(new Error('metadata is too large (8KB max)'), { statusCode: 400 });
  }

  const walk = (value) => {
    if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https:\/\//i.test(value)) {
      throw Object.assign(new Error('URLs in metadata must be https://'), { statusCode: 400 });
    }
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(metadata);

  return metadata;
}

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
    const { project_id, unit_number, unit_type, size_sqm, list_price, metadata } = req.body || {};
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
        metadata: sanitizeMetadata(metadata),
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
        metadata: sanitizeMetadata(unit.metadata),
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

// Price corrections, a floor plan added after the fact, a unit taken off the
// market. Status is deliberately NOT settable here: a unit's status follows
// its reservation (see routes/reservations.js), and letting it be set directly
// is how a sold unit gets marked available and sold a second time.
router.patch('/:id', async (req, res, next) => {
  try {
    const { unit_number, unit_type, size_sqm, list_price, metadata } = req.body || {};
    const updates = {};
    if (unit_number !== undefined) updates.unit_number = unit_number;
    if (unit_type !== undefined) updates.unit_type = unit_type || null;
    if (size_sqm !== undefined) updates.size_sqm = size_sqm ?? null;
    if (list_price !== undefined) {
      if (Number(list_price) < 0) return res.status(400).json({ error: 'list_price cannot be negative' });
      updates.list_price = list_price;
    }
    if (metadata !== undefined) updates.metadata = sanitizeMetadata(metadata);

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_units')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .maybeSingle();

    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Another unit in this project already has that number' });
    }
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Unit not found' });
    res.json(data);
  } catch (e) { next(e); }
});

// Upload a floor plan or a photo.
//
// Base64 in a JSON body rather than multipart, so this needs no upload
// middleware and no new dependency for what is a handful of files per unit.
// The 33% encoding overhead is irrelevant at 6MB and the simplicity is not:
// multipart parsing is a dependency, a stream, and a class of bug, in
// exchange for nothing a developer uploading a floor plan would ever notice.
router.post('/:id/media', async (req, res, next) => {
  try {
    const { data: unit } = await supabaseAdmin
      .from('re_units').select('id, metadata')
      .eq('id', req.params.id).eq('organization_id', req.orgId).maybeSingle();
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const { content, content_type, kind, label } = req.body || {};
    if (!content || !content_type) {
      return res.status(400).json({ error: 'content (base64) and content_type are required' });
    }
    if (!MEDIA_TYPES[content_type]) {
      return res.status(400).json({
        error: `content_type must be one of: ${Object.keys(MEDIA_TYPES).join(', ')}`,
      });
    }
    if (!['floor_plan', 'photo', 'site_map', 'brochure'].includes(kind || 'photo')) {
      return res.status(400).json({ error: 'kind must be floor_plan, photo, site_map or brochure' });
    }

    // Strip a data: URL prefix if the browser sent one whole.
    const base64 = String(content).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'content is not valid base64' });
    if (buffer.length > MAX_MEDIA_BYTES) {
      return res.status(400).json({ error: 'That file is larger than 6MB.' });
    }

    const mediaKind = kind || 'photo';
    const stored = await uploadMedia(
      `${req.orgId}/units/${unit.id}/${mediaKind}-${Date.now()}`,
      buffer,
      content_type
    );

    // metadata.media is an append-only list on the unit. jsonb rather than a
    // table because what a developer wants to attach is not knowable in
    // advance, and every guess would have been a migration.
    const metadata = unit.metadata && typeof unit.metadata === 'object' ? unit.metadata : {};
    const media = Array.isArray(metadata.media) ? metadata.media : [];
    media.push({
      kind: mediaKind,
      label: label || null,
      url: stored.url,
      path: stored.path,
      uploaded_at: new Date().toISOString(),
    });

    // The first floor plan is promoted to a named field, because that is the
    // one a rep pulls up mid-call and it should not require walking a list.
    if (mediaKind === 'floor_plan' && !metadata.floor_plan_url) {
      metadata.floor_plan_url = stored.url;
    }

    const { data, error } = await supabaseAdmin
      .from('re_units')
      .update({ metadata: { ...metadata, media } })
      .eq('id', unit.id)
      .eq('organization_id', req.orgId)
      .select()
      .single();
    if (error) throw error;

    audit(req, {
      action: 'unit.media_added',
      entityType: 're_units',
      entityId: unit.id,
      summary: `${mediaKind.replace(/_/g, ' ')} uploaded`,
      metadata: { kind: mediaKind, bytes: buffer.length },
    });

    res.status(201).json({ unit: data, media: media[media.length - 1] });
  } catch (e) { next(e); }
});

module.exports = router;
