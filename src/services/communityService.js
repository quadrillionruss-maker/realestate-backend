// communityService.js — the buyer community forum, SECTION 13.
//
// Scoped to a PROJECT. Every post and reply is authored by a customer_id —
// there is no staff-authorship column in migrations/037, so staff never
// posts as themselves here; PATCH .../pin and DELETE are the only staff
// actions, both acting on a buyer's own post rather than creating one.
//
// "No buyer can see another buyer's personal financial details — community
// is public text only within the project": every query below selects
// full_name and nothing else off re_customers, and never joins a
// reservation, payment or credit score.
const { supabaseAdmin } = require('../middleware/orgContext');
const { audit, auditSystem } = require('./auditService');
const featureUsage = require('./featureUsageService');

const POST_MAX_LENGTH = 500;
const REPLY_MAX_LENGTH = 300;
const REPORT_REASON_MAX_LENGTH = 300;

// A buyer may only ever reach a project they actually hold a unit in — this
// is the check that makes reading (and posting into) a community safe to
// expose given nothing else here re-derives "which project is this buyer's
// own". Without it, any buyer of the same developer could pass a different
// project_id and read a community they have no unit in.
async function assertBuyerInProject(customer, projectId) {
  const { data } = await supabaseAdmin
    .from('re_reservations')
    .select('id, re_units!inner(project_id)')
    .eq('organization_id', customer.organization_id)
    .eq('customer_id', customer.id)
    .eq('re_units.project_id', projectId)
    .neq('status', 'cancelled')
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

async function listPosts(orgId, projectId) {
  const { data: posts, error } = await supabaseAdmin
    .from('re_community_posts')
    .select('id, content, pinned, moderated, created_at, customer_id, re_customers(full_name)')
    .eq('organization_id', orgId)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;

  const postIds = (posts || []).map((p) => p.id);
  const { data: replies } = postIds.length
    ? await supabaseAdmin
        .from('re_community_replies')
        .select('id, post_id, content, created_at, customer_id, re_customers(full_name)')
        .in('post_id', postIds)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
    : { data: [] };

  return (posts || []).map((post) => ({
    ...post,
    author_name: post.re_customers?.full_name || 'A buyer',
    replies: (replies || [])
      .filter((r) => r.post_id === post.id)
      .map((r) => ({ ...r, author_name: r.re_customers?.full_name || 'A buyer' })),
  }));
}

async function createPost(customer, projectId, content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) throw Object.assign(new Error('content is required'), { statusCode: 400 });
  if (trimmed.length > POST_MAX_LENGTH) {
    throw Object.assign(new Error(`content must be ${POST_MAX_LENGTH} characters or fewer`), { statusCode: 400 });
  }
  if (!(await assertBuyerInProject(customer, projectId))) {
    throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from('re_community_posts')
    .insert({ organization_id: customer.organization_id, project_id: projectId, customer_id: customer.id, content: trimmed })
    .select('id, content, pinned, moderated, created_at, customer_id')
    .single();
  if (error) throw error;

  auditSystem({
    orgId: customer.organization_id,
    actorKind: 'portal',
    actorEmail: customer.email,
    action: 'community.post_created',
    entityType: 're_community_posts',
    entityId: data.id,
    summary: `${customer.full_name} posted in the project community`,
    metadata: { project_id: projectId },
  });

  featureUsage.track(customer.organization_id, 'community_posted');

  return { ...data, author_name: customer.full_name, replies: [] };
}

async function createReply(customer, postId, content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) throw Object.assign(new Error('content is required'), { statusCode: 400 });
  if (trimmed.length > REPLY_MAX_LENGTH) {
    throw Object.assign(new Error(`content must be ${REPLY_MAX_LENGTH} characters or fewer`), { statusCode: 400 });
  }

  const { data: post } = await supabaseAdmin
    .from('re_community_posts')
    .select('id, project_id').eq('id', postId).eq('organization_id', customer.organization_id).is('deleted_at', null).maybeSingle();
  if (!post) throw Object.assign(new Error('Post not found'), { statusCode: 404 });
  if (!(await assertBuyerInProject(customer, post.project_id))) {
    throw Object.assign(new Error('Post not found'), { statusCode: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from('re_community_replies')
    .insert({ post_id: postId, organization_id: customer.organization_id, customer_id: customer.id, content: trimmed })
    .select('id, post_id, content, created_at, customer_id')
    .single();
  if (error) throw error;

  // TASK 3 AUDIT FIX (Important #8) — every sibling community action
  // (createPost, deleteOwnPost, moderateDelete, setPinned) is audited;
  // this was the one state-changing action in this file that wasn't.
  auditSystem({
    orgId: customer.organization_id,
    actorKind: 'portal',
    actorEmail: customer.email,
    action: 'community.reply_created',
    entityType: 're_community_replies',
    entityId: data.id,
    summary: `${customer.full_name} replied in the project community`,
    metadata: { post_id: postId },
  });

  return { ...data, author_name: customer.full_name };
}

// TASK 3 AUDIT FIX (Important #13) — the only remedies for an unwanted post
// used to be the author deleting it themselves or staff already knowing to
// look (moderateDelete). This gives any OTHER buyer a way to flag it —
// filing a task the same way logSnag files one for its assigned rep, except
// a report has no natural single assignee, so it lands unassigned in the
// same open-tasks pool owner/sales_director (community.moderate) already
// triage from. Reporting never deletes or hides anything itself — staff
// still act through the existing moderateDelete/setPinned actions.
async function reportPost(customer, postId, reason) {
  const trimmedReason = String(reason || '').trim().slice(0, REPORT_REASON_MAX_LENGTH);

  const { data: post } = await supabaseAdmin
    .from('re_community_posts')
    .select('id, project_id, content, re_customers(full_name), re_projects(name)')
    .eq('id', postId)
    .eq('organization_id', customer.organization_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!post) throw Object.assign(new Error('Post not found'), { statusCode: 404 });
  if (!(await assertBuyerInProject(customer, post.project_id))) {
    throw Object.assign(new Error('Post not found'), { statusCode: 404 });
  }

  const { data: task, error } = await supabaseAdmin
    .from('re_tasks')
    .insert({
      organization_id: customer.organization_id,
      title: `Community post reported — ${post.re_projects?.name || 'a project'}`,
      notes: `${customer.full_name} reported a post by ${post.re_customers?.full_name || 'a buyer'}.`
        + (trimmedReason ? ` Reason given: "${trimmedReason}"` : ' No reason given.')
        + `\n\nReported post: "${post.content}"`,
      source: 'ai',
    })
    .select('id')
    .single();
  if (error) throw error;

  auditSystem({
    orgId: customer.organization_id,
    actorKind: 'portal',
    actorEmail: customer.email,
    action: 'community.post_reported',
    entityType: 're_community_posts',
    entityId: postId,
    summary: `${customer.full_name} reported a community post for review`,
    metadata: { reason: trimmedReason || null, task_id: task.id },
  });

  return { reported: true };
}

// Portal: a buyer deleting their OWN post — soft delete, same as everything
// else in this product (CLAUDE.md's "nothing is ever deleted").
async function deleteOwnPost(customer, postId) {
  const { data, error } = await supabaseAdmin
    .from('re_community_posts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', postId)
    .eq('organization_id', customer.organization_id)
    .eq('customer_id', customer.id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { notFound: true };

  auditSystem({
    orgId: customer.organization_id,
    actorKind: 'portal',
    actorEmail: customer.email,
    action: 'community.post_deleted_by_author',
    entityType: 're_community_posts',
    entityId: postId,
  });

  return { deleted: true };
}

// ── Staff (owner/sales_director) ────────────────────────────────────────
async function listPostsForStaff(orgId, projectId) {
  return listPosts(orgId, projectId);
}

async function moderateDelete(req, postId) {
  const { data, error } = await supabaseAdmin
    .from('re_community_posts')
    .update({ deleted_at: new Date().toISOString(), moderated: true })
    .eq('id', postId)
    .eq('organization_id', req.orgId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { notFound: true };

  audit(req, {
    action: 'community.post_moderated',
    entityType: 're_community_posts',
    entityId: postId,
    summary: 'Community post removed by moderation',
  });

  return { deleted: true };
}

async function setPinned(req, postId, pinned) {
  const { data, error } = await supabaseAdmin
    .from('re_community_posts')
    .update({ pinned: Boolean(pinned) })
    .eq('id', postId)
    .eq('organization_id', req.orgId)
    .is('deleted_at', null)
    .select('id, pinned')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { notFound: true };

  audit(req, {
    action: 'community.post_pin_changed',
    entityType: 're_community_posts',
    entityId: postId,
    summary: data.pinned ? 'Community post pinned' : 'Community post unpinned',
  });

  return data;
}

module.exports = {
  POST_MAX_LENGTH, REPLY_MAX_LENGTH, REPORT_REASON_MAX_LENGTH, assertBuyerInProject,
  listPosts, createPost, createReply, reportPost, deleteOwnPost, listPostsForStaff, moderateDelete, setPinned,
};
