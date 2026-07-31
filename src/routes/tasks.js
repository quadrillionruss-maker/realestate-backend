const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission, isOwnRecordsOnly, salesRepIdsFor } = require('../middleware/rbac');
const router = express.Router();

const TASK_STATUSES = ['open', 'done', 'dismissed'];
const TASK_SOURCES = ['manual', 'ai'];

// One list for both human and AI work. The `source` column is what lets the
// dashboard say "4 of these were suggested by your AI" — and is the seam the
// Deal Manager writes through later (docs/AI_WORKFORCE.md).
//
// Filtered by role, per the spec — but re_tasks carries no category of its
// own (no "this is a collections task" / "this is a document task" column),
// only assigned_to and related_reservation_id. The one filter that maps onto
// real data is a Sales Executive's own reservations, so that is the one
// enforced here; Collections and Documentation see the same full list Owner
// and Sales Director do, rather than a heuristic guessed from a task's title.
router.get('/', requirePermission('tasks.read'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_tasks')
      .select('*, re_reservations(id, re_customers(full_name, phone), re_units(unit_number, re_projects(name)))')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });

    if (req.query.status) {
      if (!TASK_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
      }
      query = query.eq('status', req.query.status);
    }
    if (req.query.source) {
      if (!TASK_SOURCES.includes(req.query.source)) {
        return res.status(400).json({ error: `source must be one of: ${TASK_SOURCES.join(', ')}` });
      }
      query = query.eq('source', req.query.source);
    }

    if (isOwnRecordsOnly(req.orgRole)) {
      const repIds = await salesRepIdsFor(req);
      let ownReservationIds = [];
      if (repIds.length) {
        const { data: owned } = await supabaseAdmin
          .from('re_reservations').select('id')
          .eq('organization_id', req.orgId).in('sales_rep_id', repIds);
        ownReservationIds = (owned || []).map((r) => r.id);
      }
      // A task assigned to them directly counts as theirs even with no
      // reservation attached (e.g. a colleague hands them a follow-up).
      query = query.or(
        [
          `assigned_to.eq.${req.userId}`,
          ownReservationIds.length ? `related_reservation_id.in.(${ownReservationIds.join(',')})` : null,
        ].filter(Boolean).join(',')
      );
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/', requirePermission('tasks.write'), async (req, res, next) => {
  try {
    const { title, notes, due_date, assigned_to, related_reservation_id } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title is required' });

    if (related_reservation_id) {
      const { data: reservation } = await supabaseAdmin
        .from('re_reservations').select('id')
        .eq('id', related_reservation_id).eq('organization_id', req.orgId).maybeSingle();
      if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_tasks')
      .insert({
        organization_id: req.orgId,
        title,
        notes: notes || null,
        due_date: due_date || null,
        assigned_to: assigned_to || null,
        related_reservation_id: related_reservation_id || null,
        source: 'manual', // 'ai' is written by the brief job, never by a client
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.patch('/:id/status', requirePermission('tasks.write'), async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!TASK_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
    }

    const { data, error } = await supabaseAdmin
      .from('re_tasks')
      .update({ status })
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Task not found' });
    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
