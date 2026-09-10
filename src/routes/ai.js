// routes/ai.js — SECTION 6 of the intelligence/outcome-tracking/AI
// assistant feature expansion. "Archta Intelligence": the conversational
// assistant's own two surfaces — asking it something, and the chat
// bubble's unread proactive-insight indicator.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requirePermission } = require('../middleware/rbac');
const { supabaseAdmin } = require('../middleware/orgContext');
const assistant = require('../services/aiAssistantService');
const router = express.Router();

// Same shape as audit.js's own undoLimiter — per WORKSPACE (req.orgId), not
// per user, per the commissioning spec's own "50 per day per workspace".
const askLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: (req) => req.orgId,
  message: { error: 'Archta Intelligence is limited to 50 questions per day for this workspace. Try again tomorrow.' },
});

// RECOMMENDATION FEEDBACK — deliberately its own, far more generous budget
// than askLimiter above: a vote costs no OpenAI tokens at all, so tying it
// to the same 50/day-per-workspace question cap would mean a busy day of
// asking Archta things blocks rating any of those answers, on the one metric
// where a busy day is exactly when the signal matters most.
const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.orgId,
  message: { error: 'Too many feedback submissions. Wait a few minutes and try again.' },
});

router.post('/ask', askLimiter, requirePermission('ai.ask'), async (req, res, next) => {
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (question.length > 2000) return res.status(400).json({ error: 'question must be 2000 characters or fewer' });

    const history = Array.isArray(req.body?.conversation_history) ? req.body.conversation_history : [];

    const result = await assistant.askAssistant(req.orgId, req.userId, question, history);
    res.json(result);
  } catch (e) { next(e); }
});

// RECOMMENDATION FEEDBACK — thumbs up/down under an answer. Same permission
// as asking a question in the first place: anyone who can ask Archta
// Intelligence something can rate its answer.
router.post('/feedback', feedbackLimiter, requirePermission('ai.ask'), async (req, res, next) => {
  try {
    const { conversation_id: conversationId, question, answer, feedback } = req.body || {};
    if (!['positive', 'negative'].includes(feedback)) {
      return res.status(400).json({ error: 'feedback must be positive or negative' });
    }
    if (!String(question || '').trim() || !String(answer || '').trim()) {
      return res.status(400).json({ error: 'question and answer are required' });
    }

    const result = await assistant.submitFeedback(req.orgId, req.userId, { conversationId, question, answer, feedback });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// The chat bubble's own unread indicator — the single most recent
// undismissed insight, if any. Never more than one at a time is shown
// (a second daily check only ever fires once nothing is already open —
// jobs/daily.js's own dedup), so "is there one" and "what is the newest
// one" are the same question.
router.get('/proactive-insight', requirePermission('ai.ask'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_ai_proactive_insights')
      .select('id, message, question, trigger_reason, created_at')
      .eq('organization_id', req.orgId)
      .is('dismissed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    res.json(data || null);
  } catch (e) { next(e); }
});

router.post('/proactive-insight/:id/dismiss', requirePermission('ai.ask'), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('re_ai_proactive_insights')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .is('dismissed_at', null);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
