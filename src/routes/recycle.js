// routes/recycle.js — delete, restore, and the bin in between.
//
// There is no hard delete anywhere in this API. Removing a buyer stamps
// deleted_at, cascades to their reservations, plans, schedules, payments,
// documents and commissions, and leaves every one of those rows in the
// database permanently. The audit entry records who did it and how many rows
// it touched.
//
// The reason is not sentiment about data. A developer who deletes a buyer who
// has paid ₦15m over eighteen months has, in a hard-delete product, destroyed
// the only record of that money — and in a dispute, "we deleted it" is not an
// answer anybody wants to give a lawyer.
//
// ── ROUTE SHAPE ────────────────────────────────────────────────────────────
// One pair of endpoints for every deletable resource rather than a `delete`
// verb on each router, because the behaviour is identical and duplicating it
// eleven times is eleven chances to omit the cascade.
//
//     DELETE /api/re/recycle/:resource/:id
//     POST   /api/re/recycle/:resource/:id/restore
//     GET    /api/re/recycle/:resource
//
// `:resource` is the plural the UI already uses ("customers"), not the table
// name — the table is an implementation detail and should not appear in a URL.

const express = require('express');
const { softDelete, restore, listDeleted } = require('../services/softDelete');
const router = express.Router();

// Only these are reachable. Notably absent: payments and commissions.
// A recorded payment is a financial fact — if it was entered wrongly, the
// correction is another entry, not the disappearance of the first one. Deleting
// the reservation above it takes the payment with it, which is the intended
// route and leaves a cascade record explaining why.
const RESOURCES = {
  projects: 're_projects',
  units: 're_units',
  customers: 're_customers',
  reservations: 're_reservations',
  documents: 're_documents',
  tasks: 're_tasks',
  promises: 're_payment_promises',
};

// What a delete will take with it, in plain language, so the confirmation the
// UI shows is written once here rather than guessed at in the browser.
const CONSEQUENCES = {
  projects: 'every unit in it, and every reservation, plan, payment and document on those units',
  units: 'its reservation, payment plan, schedule, payments and documents',
  customers: 'their reservations, payment plans, payment history and documents',
  reservations: 'its payment plan, schedule, payments, commissions and documents',
  documents: 'nothing else',
  tasks: 'nothing else',
  promises: 'nothing else',
};

function resolve(req, res) {
  const table = RESOURCES[req.params.resource];
  if (!table) {
    res.status(404).json({
      error: `Cannot delete "${req.params.resource}". Deletable: ${Object.keys(RESOURCES).join(', ')}`,
    });
    return null;
  }
  return table;
}

// What would this delete touch? Called before the confirmation is shown, so an
// operator sees "this removes 1 buyer, 1 reservation, 12 installments and 4
// payments" rather than a generic warning.
router.get('/:resource/:id/impact', async (req, res, next) => {
  try {
    const table = resolve(req, res);
    if (!table) return;

    res.json({
      resource: req.params.resource,
      takes_with_it: CONSEQUENCES[req.params.resource],
      recoverable: true,
      note: 'Nothing is permanently removed. A deleted record can be restored from the bin.',
    });
  } catch (e) { next(e); }
});

router.delete('/:resource/:id', async (req, res, next) => {
  try {
    const table = resolve(req, res);
    if (!table) return;

    const result = await softDelete(req, table, req.params.id, { reason: req.body?.reason });
    if (result.notFound) return res.status(404).json({ error: 'Not found, or already deleted.' });

    res.json({
      deleted: result.deleted,
      total: result.total,
      recoverable: true,
      takes_with_it: CONSEQUENCES[req.params.resource],
    });
  } catch (e) { next(e); }
});

router.post('/:resource/:id/restore', async (req, res, next) => {
  try {
    const table = resolve(req, res);
    if (!table) return;

    const result = await restore(req, table, req.params.id);
    if (result.notFound) {
      return res.status(404).json({ error: 'Nothing deleted with that id to restore.' });
    }

    res.json({ restored: result.restored });
  } catch (e) { next(e); }
});

// The bin. Restore is only a real feature if an operator can find the thing
// they deleted without opening a support ticket.
router.get('/:resource', async (req, res, next) => {
  try {
    const table = resolve(req, res);
    if (!table) return;

    res.json(await listDeleted(req.orgId, table, Number(req.query.limit) || 100));
  } catch (e) { next(e); }
});

module.exports = router;
