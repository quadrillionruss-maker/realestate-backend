const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const { audit } = require('../services/auditService');
const construction = require('../services/constructionService');
const contractors = require('../services/contractorService');
const projectHealth = require('../services/projectHealthService');
const projectTimeline = require('../services/projectTimelineService');
const { generateSummary: generateProjectSummary, getSummary: getProjectSummary } = require('../services/projectSummaryService');
const router = express.Router();

// Up to 10 photos per milestone, a handful of milestones per project — this
// is nowhere near payment-link or export traffic, so the generic global
// limiter's budget is not worth a dedicated one this tight. Kept anyway,
// same reasoning as every other upload route in this product: base64 in a
// JSON body has no built-in size ceiling of its own until documentStorage's
// MAX_MEDIA_BYTES check runs, and that check happens after the request body
// has already been parsed and paid for.
const milestonePhotoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  message: { error: 'Too many photo uploads. Wait a few minutes and try again.' },
});

const PROJECT_STATUSES = ['planning', 'active', 'sold_out', 'archived'];

// total_units has no database constraint of its own; the app is the only
// thing standing between a typo and a negative or non-finite unit count
// feeding the dashboard's occupancy math.
function invalidUnitCount(value) {
  return !Number.isFinite(Number(value)) || Number(value) < 0;
}

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
    if (total_units != null && invalidUnitCount(total_units)) {
      return res.status(400).json({ error: 'total_units must be a non-negative number' });
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

    // A project is the root of the deepest soft-delete cascade in the schema
    // (units → reservations → plans → schedule → payments/documents all hang
    // off it) — worth a record of who created it and with what starting shape.
    audit(req, {
      action: 'project.created',
      entityType: 're_projects',
      entityId: data.id,
      summary: `Project "${data.name}" created`,
      metadata: { name: data.name, location: data.location, total_units: data.total_units, status: data.status },
    });

    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.patch('/:id', requirePermission('inventory.write'), async (req, res, next) => {
  try {
    const { name, location, total_units, status } = req.body || {};
    if (status && !PROJECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${PROJECT_STATUSES.join(', ')}` });
    }
    if (total_units != null && invalidUnitCount(total_units)) {
      return res.status(400).json({ error: 'total_units must be a non-negative number' });
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

    // SECTION 7 (feature expansion) — read BEFORE the update, so the
    // project_completed timeline event below can tell "just went sold_out"
    // from "already was, this is an unrelated later edit" — same dedup
    // shape handoverService's own signed_off trigger already uses.
    const wasAlreadySoldOut = updates.status === 'sold_out'
      ? (await supabaseAdmin.from('re_projects').select('status').eq('id', req.params.id).eq('organization_id', req.orgId).maybeSingle()).data?.status === 'sold_out'
      : true;

    const { data, error } = await supabaseAdmin
      .from('re_projects')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Project not found' });

    audit(req, {
      action: 'project.updated',
      entityType: 're_projects',
      entityId: data.id,
      summary: `Project "${data.name}" updated`,
      metadata: updates,
    });

    // There is no literal "completed" project status in this schema —
    // 'sold_out' (migrations/001) is its closest equivalent, see
    // migrations/079's own header.
    if (data.status === 'sold_out' && !wasAlreadySoldOut) {
      await projectTimeline.logEvent(req.orgId, data.id, 'project_completed', {});
      // SECTION 8 (feature expansion) — institutional memory. Generated
      // once, here, at the moment a project completes — never inline in
      // this response (an OpenAI round trip has no place blocking a status
      // PATCH), and never throws over it: the status change is already
      // real and committed by this point.
      generateProjectSummary(req.orgId, data.id).catch((err) => {
        console.warn('[projects] could not generate the project summary:', err.message);
      });
    }

    res.json(data);
  } catch (e) { next(e); }
});

// ── Construction milestones (SECTION 2) ─────────────────────────────────
// Read is open to every role that can read inventory at all (same as
// GET /projects itself); writing dates/percentages/photos is
// owner + sales_director only (construction.manage) — a sales_rep sees
// progress but does not set it, matching "milestone management UI... owner
// and sales_director only" in the product spec.

async function assertProjectInOrg(req, res) {
  const { data, error } = await supabaseAdmin
    .from('re_projects').select('id').eq('id', req.params.id).eq('organization_id', req.orgId).maybeSingle();
  if (error) throw error;
  if (!data) { res.status(404).json({ error: 'Project not found' }); return false; }
  return true;
}

router.get('/:id/milestones', requirePermission('inventory.read'), async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    res.json(await construction.getMilestones(req.orgId, req.params.id));
  } catch (e) { next(e); }
});

// SECTION 7 (feature expansion) — longitudinal project timeline. Same
// inventory.read tier as milestones just above: a full operational history
// (reservations, payments, defaults/recoveries, restructures, documents,
// legal action, handovers, completion) is descriptive, not a financial
// amount gated behind financial.view the way a naira figure would be.
router.get('/:id/timeline', requirePermission('inventory.read'), async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    res.json(await projectTimeline.getTimeline(req.orgId, req.params.id));
  } catch (e) { next(e); }
});

// SECTION 8 (feature expansion) — institutional memory. null until the
// project has actually completed (generateProjectSummary only ever runs
// off the project_completed trigger above) — a project still in progress
// simply has no summary yet, not an empty placeholder one.
router.get('/:id/summary', requirePermission('inventory.read'), async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    res.json(await getProjectSummary(req.orgId, req.params.id));
  } catch (e) { next(e); }
});

// Manual regenerate — the spec's own "if underlying data changes after the
// fact, provide a mechanism to regenerate rather than presenting a stale
// summary". Same tier as writing to the project at all (inventory.write,
// not the read-only tier the GET above uses) — this re-runs a real OpenAI
// call, not a free read.
router.post('/:id/summary/regenerate', requirePermission('inventory.write'), async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    const summary = await generateProjectSummary(req.orgId, req.params.id);
    if (!summary) return res.status(404).json({ error: 'Project not found' });
    res.json(summary);
  } catch (e) { next(e); }
});

// Idempotent — ensures the five fixed-name rows exist for this project and
// returns them. There is no "create a custom milestone": the five names are
// the whole vocabulary (see migrations/022's check constraint).
router.post('/:id/milestones', requirePermission('construction.manage'), async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    res.status(201).json(await construction.getMilestones(req.orgId, req.params.id));
  } catch (e) { next(e); }
});

router.patch('/:id/milestones/:milestoneId', requirePermission('construction.manage'), async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    const { target_date, completed_date, completion_percentage, status } = req.body || {};
    const updated = await construction.updateMilestone(req, req.params.id, req.params.milestoneId, {
      target_date, completed_date, completion_percentage, status,
    });
    res.json(updated);
  } catch (e) { next(e); }
});

// Base64 photos in the JSON body, same tradeoff as every other image
// upload in this product (team logo, avatar, unit media) — no multipart
// middleware, no new dependency, for something uploaded a handful of times
// per project. `photos` is an array of { content, content_type }.
router.post('/:id/milestones/:milestoneId/photos', requirePermission('construction.manage'), milestonePhotoLimiter, async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    const photos = Array.isArray(req.body?.photos) ? req.body.photos : [];
    if (!photos.length) return res.status(400).json({ error: 'photos (an array of { content, content_type }) is required.' });

    const updated = await construction.addPhotos(req, req.params.id, req.params.milestoneId, photos);
    res.json(updated);
  } catch (e) { next(e); }
});

// ── Contractors and supplier payments (SECTION 12) ─────────────────────
// Owner only throughout (contractors.manage) — construction-cost outflows
// and the cash-flow forecast built from them sit at the same tier as the
// investor report, not general inventory management.
router.get('/:id/contractors', requirePermission('contractors.manage'), async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    res.json(await contractors.listContractors(req.orgId, req.params.id));
  } catch (e) { next(e); }
});

router.post('/:id/contractors', requirePermission('contractors.manage'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await contractors.createContractor(req, req.params.id, {
      name: body.name, type: body.type, phone: body.phone, email: body.email,
    });
    if (result.notFound) return res.status(404).json({ error: 'Project not found' });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.get('/:id/contractor-payments', requirePermission('contractors.manage'), async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    const [payments, forecast] = await Promise.all([
      contractors.listPayments(req.orgId, req.params.id),
      contractors.cashFlowForecast(req.orgId, req.params.id),
    ]);
    res.json({ payments, forecast });
  } catch (e) { next(e); }
});

router.post('/:id/contractor-payments', requirePermission('contractors.manage'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await contractors.createPayment(req, req.params.id, {
      contractorId: body.contractor_id,
      milestoneId: body.milestone_id,
      amount: body.amount,
      dueDate: body.due_date,
      description: body.description,
    });
    if (result.notFound) return res.status(404).json({ error: 'Project not found' });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// SECTION 15 — abandoned project early warning system. Owner only
// (projectHealth.read). Computed once a day by jobs/daily.js; this just
// reads back whatever the most recent run stored.
router.get('/:id/health', requirePermission('projectHealth.read'), async (req, res, next) => {
  try {
    if (!(await assertProjectInOrg(req, res))) return;
    const data = await projectHealth.getLatestHealth(req.orgId, req.params.id);
    if (!data) return res.status(404).json({ error: 'No health score computed for this project yet.' });
    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
