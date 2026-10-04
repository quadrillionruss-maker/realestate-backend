// routes/group.js — the group owner's consolidated view across branches.
//
// Deliberately NOT scoped by req.orgId/orgContext the way every other route
// in this file is: a group spans several organization_id values by design,
// and "which branches" is answered by parent_organizations.owner_id, not by
// whichever single workspace this browser happens to be switched into right
// now. req.userId (set by orgContext from the same authenticated user) is
// what every handler here actually keys off.
const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const group = require('../services/groupService');
const router = express.Router();

// A caller who owns no group and holds no branch grant gets an honest "you
// don't have one" rather than a 403 — this isn't a permission the caller
// lacks, it's a concept that simply doesn't apply to most people, same as
// `workspaces` on GET /auth/me being empty for a solo account. Owner and
// grantee share this one route; group.getDashboard decides which, if either,
// applies and the response's own is_group_owner/is_branch_viewer say which.
router.get('/dashboard', async (req, res, next) => {
  try {
    const dashboard = await group.getDashboard(req.userId);
    if (!dashboard) {
      return res.json({ is_group_owner: false, is_branch_viewer: false, groups: [], branches: [], totals: null });
    }
    res.json(dashboard);
  } catch (e) { next(e); }
});

// Creating and reshaping a group is owner-level by nature — the same person
// who could turn their own solo workspace into a team is the one who may
// fold that workspace into (or out of) a group above it.
router.post('/', requirePermission('group.manage'), async (req, res, next) => {
  try {
    const created = await group.createGroup(req.userId, req.body?.name);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.post('/branches', requirePermission('group.manage'), async (req, res, next) => {
  try {
    const { group_id: groupId, team_id: teamId } = req.body || {};
    if (!groupId || !teamId) {
      return res.status(400).json({ error: 'group_id and team_id are required.' });
    }
    const branch = await group.attachBranch(req.userId, groupId, teamId);
    res.json(branch);
  } catch (e) { next(e); }
});

router.delete('/branches/:teamId', requirePermission('group.manage'), async (req, res, next) => {
  try {
    const result = await group.detachBranch(req.userId, req.params.teamId);
    res.json(result);
  } catch (e) { next(e); }
});

// Per-user branch access — a group owner handing one named person read
// access to one named branch's numbers, without making them a member of
// that branch's own team_members. Same owner-level gate as every other
// group-shaping route above.
router.get('/access', requirePermission('group.manage'), async (req, res, next) => {
  try {
    res.json(await group.listBranchGrants(req.userId));
  } catch (e) { next(e); }
});

router.post('/branches/:teamId/access', requirePermission('group.manage'), async (req, res, next) => {
  try {
    const { user_id: userId, email } = req.body || {};
    if (!userId && !email) return res.status(400).json({ error: 'user_id or email is required.' });
    const grant = await group.grantBranchAccess(req.userId, req.params.teamId, { userId, email });
    res.status(201).json(grant);
  } catch (e) { next(e); }
});

router.delete('/branches/:teamId/access/:userId', requirePermission('group.manage'), async (req, res, next) => {
  try {
    const result = await group.revokeBranchAccess(req.userId, req.params.teamId, req.params.userId);
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
