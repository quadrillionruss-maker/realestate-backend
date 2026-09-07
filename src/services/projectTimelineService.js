// projectTimelineService.js — SECTION 7 of the intelligence/outcome-
// tracking/AI assistant feature expansion. The one place that writes and
// reads re_project_events (migrations/079).
//
// ── Which triggers are actually wired, and which are not ─────────────────
// Wired: reservation_created (routes/reservations.js), payment_received
// (paymentEvents.onPaymentRecorded), buyer_defaulted/buyer_recovered
// (escalationService.sweepEscalations / paymentEvents.maybeDeescalate),
// restructure (restructureService.restructure — the same moment Section 1's
// own outcome hook fires), document_generated (documentService's first
// generation only, not a resend — see writeGeneratedVersion's own
// wasRegeneration flag), milestone_completed (constructionService.
// updateMilestone), legal_action (legalCaseService.openCase), handover
// (handoverService.updateChecklist, the same 'signed_off' + "wasn't
// already" moment its own satisfaction-survey trigger already checks for),
// project_completed (routes/projects.js, status transitioning to
// 'sold_out' — this schema's own closest equivalent; there is no literal
// 'completed' project status, see migrations/079's header).
//
// NOT wired, deliberately: construction_delay (this product tracks a
// milestone as pending/in_progress/completed — migrations/022 — with no
// "delayed" state of its own to hook; projectHealthService's own staleness
// signal is a SCORE dimension, not a discrete event, and inventing a
// delay-detection heuristic here would be a second, disagreeing definition
// of the same thing). buyer_communications (re_action_outcomes,
// migrations/073, already IS the per-buyer communications ledger — logging
// every WhatsApp/email/call a second time at the project level would flood
// this table with exactly the noise a project TIMELINE is not for; the
// commissioning spec's own example use-case for this feature — "reservations,
// defaults, recoveries, construction delays, completion date" — never
// mentions individual messages either).
//
// NOTHING HERE THROWS — this is instrumentation beside a real business
// action, same rule outcomeService.js's own header states for the same
// reason.
const { supabaseAdmin } = require('../middleware/orgContext');

async function logEvent(orgId, projectId, eventType, eventData = {}) {
  try {
    if (!orgId || !projectId || !eventType) return null;
    const { data, error } = await supabaseAdmin
      .from('re_project_events')
      .insert({ organization_id: orgId, project_id: projectId, event_type: eventType, event_data: eventData })
      .select('id')
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('[project-timeline] could not log event:', err.message);
    return null;
  }
}

async function getTimeline(orgId, projectId) {
  const { data, error } = await supabaseAdmin
    .from('re_project_events')
    .select('id, event_type, event_data, created_at')
    .eq('organization_id', orgId)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

module.exports = { logEvent, getTimeline };
