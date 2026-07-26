// routes/index.js — the whole real estate module behind one prefix.
//
// MOUNTING (FlowDesk's src/app.js), and the order matters:
//
//   const { authenticate } = require('./middleware/auth');
//   const reRoutes = require('./re/routes');
//   ...
//   app.use(express.json());   // already there
//   app.use(sanitizeBody);     // already there
//   app.use('/api/re', authenticate, reRoutes);
//
// It must sit AFTER express.json() and sanitizeBody, otherwise req.body is
// undefined in every handler below — the same mounting-order bug that bit the
// billing routes before (see the webhookRouter split in app.js).
//
// `authenticate` is FlowDesk's, deliberately: this module never verifies a
// token itself, so there is exactly one auth implementation in the codebase.
// orgContext then turns req.user into req.orgId.

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

module.exports = router;
