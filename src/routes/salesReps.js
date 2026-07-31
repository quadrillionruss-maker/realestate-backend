const express = require('express');
const { supabaseAdmin, requireRole } = require('../middleware/orgContext');
const router = express.Router();

// A sales rep is a platform user tagged for this product, joined here to their
// profile so the UI can show a name rather than a UUID.
router.get('/', async (req, res, next) => {
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

router.post('/', requireRole(['owner', 'admin']), async (req, res, next) => {
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
router.patch('/:id', requireRole(['owner', 'admin']), async (req, res, next) => {
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

module.exports = router;
