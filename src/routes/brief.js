const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const { generateDailyBrief } = require('../services/aiBrief');
const router = express.Router();

// Owner and Sales Director only — Collections gets an overdue-focused
// dashboard instead (routes/dashboard.js), and Sales Executive/Documentation
// see neither: the full strategic brief names buyers outside their own book.
router.get('/', requirePermission('brief.read'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_ai_briefs')
      .select('*')
      .eq('organization_id', req.orgId)
      .order('brief_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    res.json(data || null);
  } catch (e) { next(e); }
});

router.get('/history', requirePermission('brief.read'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 14, 90);
    const { data, error } = await supabaseAdmin
      .from('re_ai_briefs')
      .select('id, brief_date, summary, generated_by')
      .eq('organization_id', req.orgId)
      .order('brief_date', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Regenerate now — used by the dashboard's refresh button and after recording
// payments, when this morning's brief is already stale. Upserts on
// (organization_id, brief_date), so today's brief is replaced, not duplicated.
router.post('/generate', requirePermission('brief.generate'), async (req, res, next) => {
  try {
    const brief = await generateDailyBrief(req.orgId);
    res.json(brief);
  } catch (e) { next(e); }
});

module.exports = router;
