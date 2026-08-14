const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const { audit } = require('../services/auditService');
const router = express.Router();

// A sales rep is a platform user tagged for this product, joined here to their
// profile so the UI can show a name rather than a UUID.
router.get('/', requirePermission('salesReps.read'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_sales_reps')
      .select('*, users(id, full_name, email)')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });

    if (req.query.include_inactive !== 'true') query = query.eq('active', true);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/', requirePermission('salesReps.write'), async (req, res, next) => {
  try {
    const { user_id, commission_rate } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    // Only real users can be reps — the FK would reject anything else anyway,
    // but a 404 explains it better than a constraint violation.
    const { data: user } = await supabaseAdmin
      .from('users').select('id').eq('id', user_id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Identity is global, not org-scoped — without this, any caller could tag
    // an unrelated person (anyone at all in the users table) as a rep in
    // their own org, disclosing that person's name and email through this
    // org's rep/commission screens and misattributing activity to them. Same
    // "User not found" either way, so this cannot be used to test whether a
    // given user_id exists at all.
    const isSolo = req.orgId === req.userId;
    if (isSolo) {
      if (user_id !== req.userId) return res.status(404).json({ error: 'User not found' });
    } else {
      const { data: member } = await supabaseAdmin
        .from('team_members')
        .select('id')
        .eq('team_id', req.orgId)
        .eq('user_id', user_id)
        .eq('status', 'active')
        .maybeSingle();
      if (!member) return res.status(404).json({ error: 'User not found' });
    }

    // Falls back to the workspace default, so a developer sets "our reps get
    // 2.5%" once in Settings rather than on every rep they add.
    let rate = commission_rate;
    if (rate == null) {
      const { data: settings } = await supabaseAdmin
        .from('re_org_settings').select('default_commission_rate')
        .eq('organization_id', req.orgId).maybeSingle();
      rate = Number(settings?.default_commission_rate || 0);
    }
    if (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) {
      return res.status(400).json({ error: 'commission_rate must be a percentage between 0 and 100' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_sales_reps')
      .upsert(
        { organization_id: req.orgId, user_id, active: true, commission_rate: Number(rate) },
        { onConflict: 'organization_id,user_id' }
      )
      .select('*, users(id, full_name, email)')
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// Deactivate rather than delete: reservations reference the rep, and who sold
// what stays true after someone leaves.
router.patch('/:id', requirePermission('salesReps.write'), async (req, res, next) => {
  try {
    const { active, commission_rate } = req.body || {};
    const updates = {};

    if (active !== undefined) {
      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active must be true or false' });
      }
      updates.active = active;
    }

    // Changing the rate affects FUTURE accruals only. Every commission row
    // carries the rate that applied when it was earned (see
    // commissionService), so raising a rep's percentage does not quietly
    // rewrite what they were owed last quarter.
    if (commission_rate !== undefined) {
      const rate = Number(commission_rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        return res.status(400).json({ error: 'commission_rate must be a percentage between 0 and 100' });
      }
      updates.commission_rate = rate;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_sales_reps')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Sales rep not found' });
    res.json(data);
  } catch (e) { next(e); }
});

// FEATURE — the "profile" view behind Settings → Team's Sales reps card. What
// this rep is carrying right now, and who else could take it on — the same
// two questions the team-removal workload endpoint answers
// (routes/settings.js's GET /team/:id/workload), just keyed by re_sales_reps
// id directly rather than by team_members id, since this rep may still be an
// active member with no removal in sight.
router.get('/:id/summary', requirePermission('salesReps.read'), async (req, res, next) => {
  try {
    const { data: rep } = await supabaseAdmin
      .from('re_sales_reps')
      .select('id, active, commission_rate, users(full_name, email)')
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (!rep) return res.status(404).json({ error: 'Sales rep not found' });

    const { data: reservations } = await supabaseAdmin
      .from('re_reservations')
      .select('id, status')
      .eq('organization_id', req.orgId)
      .eq('sales_rep_id', rep.id);

    const rows = reservations || [];

    const { data: others } = await supabaseAdmin
      .from('re_sales_reps')
      .select('id, commission_rate, users(full_name, email)')
      .eq('organization_id', req.orgId)
      .eq('active', true)
      .neq('id', rep.id);

    res.json({
      rep: {
        id: rep.id,
        name: rep.users?.full_name || rep.users?.email || 'Unnamed rep',
        email: rep.users?.email || null,
        active: rep.active,
        commission_rate: Number(rep.commission_rate || 0),
      },
      total_reservations: rows.length,
      active_reservations: rows.filter((r) => ['reserved', 'confirmed'].includes(r.status)).length,
      other_reps: (others || []).map((r) => ({
        id: r.id,
        name: r.users?.full_name || r.users?.email || 'Unnamed rep',
        commission_rate: Number(r.commission_rate || 0),
      })),
    });
  } catch (e) { next(e); }
});

// Moves EVERY reservation this rep has ever held — not just the open ones
// the team-removal flow moves (routes/settings.js's reassignWork) — onto
// another rep in one action. Deliberately more sweeping than that flow: this
// is a manual, explicit, confirmed action a director takes on an ACTIVE rep
// (a territory handover, a portfolio rebalance), not an automatic side effect
// of someone leaving, so keeping a completed sale's original name is not the
// same default here.
//
// re_commissions rows are untouched either way — every one already carries
// the rep who was assigned when its payment landed (commissionService), so
// moving sales_rep_id here changes nothing about what was already earned.
// Only the NEXT payment on each of these reservations pays the new rep.
router.post('/:id/reassign', requirePermission('salesReps.write'), async (req, res, next) => {
  try {
    const targetRepId = req.body?.target_rep_id;
    if (!targetRepId) return res.status(400).json({ error: 'target_rep_id is required' });
    if (targetRepId === req.params.id) {
      return res.status(400).json({ error: 'Choose a different rep to reassign to.' });
    }

    const { data: source } = await supabaseAdmin
      .from('re_sales_reps')
      .select('id, users(full_name, email)')
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (!source) return res.status(404).json({ error: 'Sales rep not found' });

    const { data: target } = await supabaseAdmin
      .from('re_sales_reps')
      .select('id, active, users(full_name, email)')
      .eq('id', targetRepId)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (!target || !target.active) {
      return res.status(400).json({ error: 'Reassign to an active sales rep in this workspace.' });
    }

    const { data: moved, error } = await supabaseAdmin
      .from('re_reservations')
      .update({ sales_rep_id: targetRepId })
      .eq('organization_id', req.orgId)
      .eq('sales_rep_id', source.id)
      .select('id');
    if (error) throw error;

    const fromName = source.users?.full_name || source.users?.email || 'this rep';
    const toName = target.users?.full_name || target.users?.email || 'another rep';

    audit(req, {
      action: 'salesRep.reservations_reassigned',
      entityType: 're_sales_reps',
      entityId: source.id,
      summary: `${moved?.length || 0} reservation(s) reassigned from ${fromName} to ${toName}`,
      metadata: { from_sales_rep_id: source.id, to_sales_rep_id: targetRepId, moved: moved?.length || 0 },
    });

    res.json({ moved: moved?.length || 0, from: fromName, to: toName });
  } catch (e) { next(e); }
});

module.exports = router;
