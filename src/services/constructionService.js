// constructionService.js — construction milestone tracking (SECTION 2).
//
// Five fixed stages, always in this order. A project's milestone rows are
// provisioned lazily the first time anyone reads them — see
// ensureMilestones() — so this works uniformly for a project created before
// this feature existed and one created after, with no backfill migration.
const { supabaseAdmin } = require('../middleware/orgContext');
const { uploadMedia, MAX_MEDIA_BYTES } = require('./documentStorage');
const { sendEmail } = require('./notificationService');
const { audit } = require('./auditService');
const { escapeHtml } = require('../utils/escapeHtml');

const MILESTONE_NAMES = ['Foundation', 'Superstructure', 'Roofing', 'Finishing', 'Handover'];
const MAX_PHOTOS_PER_MILESTONE = 10;

function orderMilestones(rows) {
  const byName = new Map((rows || []).map((r) => [r.name, r]));
  return MILESTONE_NAMES.map((name) => byName.get(name)).filter(Boolean);
}

// Idempotent: an insert that races another request for the same project
// collides on the (project_id, name) unique index, which is exactly the
// "somebody already created this" case — swallowed the same way a
// duplicate-key error is treated as a no-op everywhere else in this
// product that lazily provisions a fixed row set.
async function ensureMilestones(orgId, projectId) {
  const { data: existing, error } = await supabaseAdmin
    .from('re_construction_milestones')
    .select('*')
    .eq('organization_id', orgId)
    .eq('project_id', projectId);
  if (error) throw error;

  const have = new Set((existing || []).map((r) => r.name));
  const missing = MILESTONE_NAMES.filter((name) => !have.has(name));
  if (!missing.length) return orderMilestones(existing);

  const { error: insertErr } = await supabaseAdmin
    .from('re_construction_milestones')
    .insert(missing.map((name) => ({ organization_id: orgId, project_id: projectId, name })));
  // 23505 = unique_violation — a parallel request already created the same
  // rows between the read above and this insert. The rows exist either
  // way, which is all this function promises.
  if (insertErr && insertErr.code !== '23505') throw insertErr;

  const { data: full, error: refetchErr } = await supabaseAdmin
    .from('re_construction_milestones')
    .select('*')
    .eq('organization_id', orgId)
    .eq('project_id', projectId);
  if (refetchErr) throw refetchErr;
  return orderMilestones(full);
}

async function getMilestones(orgId, projectId) {
  return ensureMilestones(orgId, projectId);
}

// For the buyer portal, which needs this for potentially several projects
// (one per reservation) in a single read rather than N round trips.
async function getMilestonesForProjects(orgId, projectIds) {
  const unique = [...new Set(projectIds.filter(Boolean))];
  if (!unique.length) return {};

  const byProject = {};
  // Each project is provisioned independently (ensureMilestones is the
  // only path that creates rows) — sequential is fine here, this only
  // ever runs against the handful of projects one buyer's own
  // reservations touch, never a whole org's worth.
  for (const projectId of unique) {
    byProject[projectId] = await ensureMilestones(orgId, projectId);
  }
  return byProject;
}

// The single fact both the portal and the Projects screen actually want:
// which stage is "current" and how far along it is. The first
// not-yet-completed milestone in sequence; if every one is completed, the
// last stage (Handover) stands in, at its own percentage.
function currentMilestoneSummary(milestones) {
  const current = milestones.find((m) => m.status !== 'completed') || milestones[milestones.length - 1];
  if (!current) return null;
  const photos = Array.isArray(current.photos) ? current.photos : [];
  return {
    milestone_id: current.id,
    name: current.name,
    status: current.status,
    completion_percentage: current.completion_percentage,
    target_date: current.target_date,
    completed_date: current.completed_date,
    latest_photo_url: photos.length ? photos[photos.length - 1].url : null,
  };
}

function findMilestone(milestones, milestoneId) {
  return milestones.find((m) => m.id === milestoneId) || null;
}

async function updateMilestone(req, projectId, milestoneId, updates) {
  const milestones = await ensureMilestones(req.orgId, projectId);
  const before = findMilestone(milestones, milestoneId);
  if (!before) {
    throw Object.assign(new Error('Milestone not found.'), { statusCode: 404 });
  }

  const patch = {};
  if (updates.target_date !== undefined) patch.target_date = updates.target_date;
  if (updates.completion_percentage !== undefined) {
    const pct = Number(updates.completion_percentage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw Object.assign(new Error('completion_percentage must be between 0 and 100.'), { statusCode: 400 });
    }
    patch.completion_percentage = pct;
  }
  if (updates.status !== undefined) {
    if (!['pending', 'in_progress', 'completed'].includes(updates.status)) {
      throw Object.assign(new Error('status must be pending, in_progress or completed.'), { statusCode: 400 });
    }
    patch.status = updates.status;
  }
  if (updates.completed_date !== undefined) patch.completed_date = updates.completed_date;

  // Reaching 100% is treated as completing the stage even if the caller
  // never touched status directly — a rep updating "we're done" via the
  // percentage field is the more natural motion than remembering there is
  // a separate status field to also flip.
  const willComplete = patch.status === 'completed'
    || (patch.completion_percentage === 100 && before.status !== 'completed');
  if (willComplete) {
    patch.status = 'completed';
    if (!patch.completed_date && !before.completed_date) {
      patch.completed_date = new Date().toISOString().slice(0, 10);
    }
  }

  patch.updated_at = new Date().toISOString();

  const { data: after, error } = await supabaseAdmin
    .from('re_construction_milestones')
    .update(patch)
    .eq('id', milestoneId)
    .eq('organization_id', req.orgId)
    .select()
    .single();
  if (error) throw error;

  audit(req, {
    action: 'construction.milestone_updated',
    entityType: 're_construction_milestones',
    entityId: after.id,
    summary: `${after.name} milestone updated on this project`,
    metadata: patch,
  });

  // Newly completed, and not already notified once for this milestone —
  // notified_at is the guard against a later edit (fixing the date, say)
  // re-sending the same "great news" email to every buyer in the project.
  const justCompleted = before.status !== 'completed' && after.status === 'completed';
  if (justCompleted && !after.notified_at) {
    await notifyBuyersOfMilestone(req.orgId, projectId, after);
  }

  return after;
}

async function addPhotos(req, projectId, milestoneId, photos) {
  const milestones = await ensureMilestones(req.orgId, projectId);
  const milestone = findMilestone(milestones, milestoneId);
  if (!milestone) {
    throw Object.assign(new Error('Milestone not found.'), { statusCode: 404 });
  }

  const existing = Array.isArray(milestone.photos) ? milestone.photos : [];
  if (existing.length + photos.length > MAX_PHOTOS_PER_MILESTONE) {
    throw Object.assign(
      new Error(`A milestone can hold at most ${MAX_PHOTOS_PER_MILESTONE} photos (${existing.length} already there).`),
      { statusCode: 400 }
    );
  }

  const uploaded = [];
  let index = existing.length;
  for (const photo of photos) {
    const base64 = String(photo.content || '').replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) {
      throw Object.assign(new Error('One of the photos is not valid base64.'), { statusCode: 400 });
    }
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw Object.assign(new Error('Each photo must be under 6MB.'), { statusCode: 400 });
    }

    // The exact path shape the product spec calls for:
    // construction/{project_id}/{milestone_id}/{filename}
    index += 1;
    const stored = await uploadMedia(
      `construction/${projectId}/${milestoneId}/${Date.now()}-${index}`,
      buffer,
      photo.content_type
    );
    uploaded.push({ path: stored.path, url: stored.url, uploaded_at: new Date().toISOString() });
  }

  const nextPhotos = [...existing, ...uploaded];
  const { data: after, error } = await supabaseAdmin
    .from('re_construction_milestones')
    .update({ photos: nextPhotos, updated_at: new Date().toISOString() })
    .eq('id', milestoneId)
    .eq('organization_id', req.orgId)
    .select()
    .single();
  if (error) throw error;

  audit(req, {
    action: 'construction.photos_added',
    entityType: 're_construction_milestones',
    entityId: after.id,
    summary: `${uploaded.length} photo(s) added to ${after.name}`,
    metadata: { count: uploaded.length },
  });

  return after;
}

// "You are now X% closer to your handover date" — X is this milestone's
// position in the fixed five-stage sequence, not its own completion
// percentage: finishing stage 3 of 5 reads as 60%, regardless of how far
// along stage 3 itself was tracked at (that number resets to 0 for the
// next stage, which would make a terrible headline).
function sequenceProgressPercent(milestoneName) {
  const index = MILESTONE_NAMES.indexOf(milestoneName);
  return Math.round(((index + 1) / MILESTONE_NAMES.length) * 100);
}

async function notifyBuyersOfMilestone(orgId, projectId, milestone) {
  const { data: project } = await supabaseAdmin
    .from('re_projects').select('name').eq('id', projectId).maybeSingle();

  const { data: reservations, error } = await supabaseAdmin
    .from('re_reservations')
    .select('id, re_units!inner(project_id), re_customers(id, full_name, email)')
    .eq('organization_id', orgId)
    .eq('re_units.project_id', projectId)
    .neq('status', 'cancelled');
  if (error) throw error;

  const percent = sequenceProgressPercent(milestone.name);
  const seen = new Set();
  let sent = 0;

  for (const reservation of reservations || []) {
    const customer = reservation.re_customers;
    if (!customer || !customer.email || seen.has(customer.id)) continue;
    seen.add(customer.id);

    const greeting = `Good news — your development has reached ${milestone.name}. `
      + `You are now ${percent}% closer to your handover date.`;

    await sendEmail({
      orgId,
      to: customer.email,
      subject: `${project?.name || 'Your development'}: ${milestone.name} reached`,
      html: `<p>Hi ${escapeHtml(customer.full_name || 'there')},</p><p>${escapeHtml(greeting)}</p>`,
      text: greeting,
      template: 'construction_milestone',
      relatedType: 're_construction_milestones',
      relatedId: milestone.id,
    });
    sent += 1;
  }

  await supabaseAdmin
    .from('re_construction_milestones')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', milestone.id);

  return { notified: sent };
}

module.exports = {
  MILESTONE_NAMES,
  MAX_PHOTOS_PER_MILESTONE,
  ensureMilestones,
  getMilestones,
  getMilestonesForProjects,
  currentMilestoneSummary,
  updateMilestone,
  addPhotos,
  sequenceProgressPercent,
  notifyBuyersOfMilestone,
};
