// routes/attendance.js — team attendance, SECTION 3 (feature expansion).
//
// One row per (user, date) — POST upserts on that pair (migrations/055's
// unique index), so marking the same person's same day again is a
// correction, not a second, disagreeing row. Owner/sales_director only for
// both reading and marking (permissions.js's attendance.read/manage) — this
// is workplace oversight of the team, not a sales action.
const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const { audit } = require('../services/auditService');
const router = express.Router();

const STATUSES = ['present', 'absent', 'late', 'half_day'];

// ?user_id= and ?month=YYYY-MM both optional — the calendar view asks for
// one person's whole month; a future per-day report could ask for
// everyone on one date instead, so both filters are independent.
router.get('/', requirePermission('attendance.read'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_attendance')
      .select('*')
      .eq('organization_id', req.orgId)
      .is('deleted_at', null)
      .order('date', { ascending: false });

    if (req.query.user_id) query = query.eq('user_id', req.query.user_id);
    if (req.query.month) {
      if (!/^\d{4}-\d{2}$/.test(req.query.month)) {
        return res.status(400).json({ error: 'month must be YYYY-MM' });
      }
      // An exclusive bound against the first day of the NEXT month, not a
      // literal "-31" — Postgres rejects an out-of-range calendar date like
      // 2026-02-31 outright, which meant this 500'd for every February,
      // April, June, September and November. Date.UTC's own month-index
      // rollover (12 -> January of the following year) handles December for
      // free.
      const [y, m] = req.query.month.split('-').map(Number);
      const nextMonthStart = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
      query = query.gte('date', `${req.query.month}-01`).lt('date', nextMonthStart);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { next(e); }
});

router.post('/', requirePermission('attendance.manage'), async (req, res, next) => {
  try {
    const { user_id, date, status, check_in_time = null, check_out_time = null, notes = null } = req.body || {};
    if (!user_id || !date || !status) {
      return res.status(400).json({ error: 'user_id, date and status are required' });
    }
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }

    // AUDIT FIX (Security #4) — this used to look `user_id` up against the
    // global, platform-wide `users` table with no check that they actually
    // belong to the caller's own workspace, which let an owner/sales
    // director link a completely unrelated org's user to their own
    // attendance records, and functioned as a blind user-existence oracle
    // across the whole platform. `user_id === req.orgId` covers a solo
    // account marking their own attendance, which has no team_members row
    // at all (CLAUDE.md's org-scoping section).
    const { data: member } = await supabaseAdmin
      .from('users').select('id, full_name, email').eq('id', user_id).maybeSingle();
    if (!member) return res.status(404).json({ error: 'User not found' });

    if (user_id !== req.orgId) {
      const { data: membership } = await supabaseAdmin
        .from('team_members')
        .select('user_id')
        .eq('team_id', req.orgId)
        .eq('user_id', user_id)
        .eq('status', 'active')
        .maybeSingle();
      if (!membership) return res.status(404).json({ error: 'User not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_attendance')
      .upsert({
        organization_id: req.orgId, user_id, date, status, check_in_time, check_out_time, notes,
      }, { onConflict: 'organization_id,user_id,date' })
      .select()
      .single();
    if (error) throw error;

    audit(req, {
      action: 'attendance.marked',
      entityType: 're_attendance',
      entityId: data.id,
      summary: `${member.full_name || member.email} marked ${status.replace('_', ' ')} for ${date}`,
      metadata: { user_id, date, status },
    });

    res.status(201).json(data);
  } catch (e) { next(e); }
});

module.exports = router;
