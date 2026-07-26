const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
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

router.post('/', async (req, res, next) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    // Only real users can be reps — the FK would reject anything else anyway,
    // but a 404 explains it better than a constraint violation.
    const { data: user } = await supabaseAdmin
      .from('users').select('id').eq('id', user_id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data, error } = await supabaseAdmin
      .from('re_sales_reps')
      .upsert({ organization_id: req.orgId, user_id, active: true }, { onConflict: 'organization_id,user_id' })
      .select('*, users(id, full_name, email)')
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// Deactivate rather than delete: reservations reference the rep, and who sold
// what stays true after someone leaves.
router.patch('/:id', async (req, res, next) => {
  try {
    const { active } = req.body || {};
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active must be true or false' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_sales_reps')
      .update({ active })
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
