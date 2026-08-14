// routes/contractorPayments.js — the one top-level route SECTION 12 needs.
// Listing and creating are nested under routes/projects.js
// (GET/POST /projects/:id/contractor-payments); this is just PATCH.
const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const contractors = require('../services/contractorService');
const router = express.Router();

router.patch('/:id', requirePermission('contractors.manage'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await contractors.updatePayment(req, req.params.id, {
      status: body.status, paidDate: body.paid_date, description: body.description,
    });
    if (result.notFound) return res.status(404).json({ error: 'Contractor payment not found' });
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
