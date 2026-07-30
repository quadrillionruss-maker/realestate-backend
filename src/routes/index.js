// routes/index.js — the whole API behind one prefix.
//
// Mounted by server.js, where the order matters:
//
//   app.use(express.json());
//   app.use('/api/re', authenticate, reRoutes);
//
// It must sit AFTER express.json(), or req.body is undefined in every handler
// below. `authenticate` runs in front rather than inside, so a route can never
// be added that forgets it; orgContext then turns req.user into req.orgId.

const express = require('express');
const { orgContext } = require('../middleware/orgContext');

const router = express.Router();

router.use(orgContext);

router.use('/projects', require('./projects'));
router.use('/units', require('./units'));
router.use('/customers', require('./customers'));
router.use('/sales-reps', require('./salesReps'));
router.use('/reservations', require('./reservations'));
router.use('/payments', require('./payments'));
router.use('/documents', require('./documents'));
router.use('/tasks', require('./tasks'));
router.use('/dashboard', require('./dashboard'));
router.use('/brief', require('./brief'));
router.use('/promises', require('./promises'));
router.use('/commissions', require('./commissions'));
router.use('/search', require('./search'));
router.use('/imports', require('./imports'));
router.use('/reports', require('./reports'));
router.use('/audit', require('./audit'));
router.use('/settings', require('./settings'));
router.use('/recycle', require('./recycle'));

module.exports = router;
