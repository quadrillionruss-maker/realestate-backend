// routes/analytics.js — SECTION 1 (feature expansion): the outcome
// database's own read side. Everything written by outcomeService.js
// (dealManager, promiseService, campaignService, restructureService,
// escalationService, collectionsAgent, overdueAlerts, paymentEvents, and
// this file's own sweep in jobs/daily.js) surfaces here as the aggregate
// patterns a workspace's collections strategy is actually built on.
const express = require('express');
const { requirePermission } = require('../middleware/rbac');
const outcomes = require('../services/outcomeService');
const recoveryPlaybook = require('../services/recoveryPlaybookService');
const developerDna = require('../services/developerDnaService');
const decisionLedger = require('../services/decisionLedgerService');
const router = express.Router();

router.get('/outcomes', requirePermission('analytics.outcomes'), async (req, res, next) => {
  try {
    const result = await outcomes.getOutcomeAnalytics(req.orgId);
    res.json(result);
  } catch (e) { next(e); }
});

// SECTION 3 (feature expansion). Same permission tier as /outcomes above —
// both read the same table, both are a workspace-wide pattern rather than
// any one director's own book, so a second near-identical permission would
// gate the same access twice under two different names.
router.get('/communication-effectiveness', requirePermission('analytics.outcomes'), async (req, res, next) => {
  try {
    const result = await outcomes.getCommunicationEffectiveness(req.orgId);
    result.top_insights = outcomes.deriveTopInsights(result);
    res.json(result);
  } catch (e) { next(e); }
});

// SECTION 4 (feature expansion). Read-only — the playbook itself is only
// ever WRITTEN by jobs/daily.js's own Monday sweep (recoveryPlaybookService.
// recomputeForAllOrgs), never on a request; this always returns whatever
// that sweep last computed, one row per escalation stage, every stage
// present even where the sweep has not run for this org yet.
router.get('/recovery-playbook', requirePermission('analytics.outcomes'), async (req, res, next) => {
  try {
    const result = await recoveryPlaybook.getPlaybook(req.orgId);
    res.json(result);
  } catch (e) { next(e); }
});

// SECTION 5 (feature expansion). Read-only, same shape as recovery-playbook
// above — written only by jobs/daily.js's own Monday sweep.
router.get('/developer-dna', requirePermission('analytics.developerDna'), async (req, res, next) => {
  try {
    const [dna, benchmark] = await Promise.all([
      developerDna.getDna(req.orgId),
      developerDna.getPeerBenchmark(req.orgId),
    ]);
    res.json({ dna, peer_benchmark: benchmark });
  } catch (e) { next(e); }
});

// Decision Ledger — override rate, outcome comparison, top override
// patterns. Same owner-only tier as developer-dna above.
router.get('/decision-ledger', requirePermission('analytics.decisionLedger'), async (req, res, next) => {
  try {
    const result = await decisionLedger.getAnalytics(req.orgId);
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
