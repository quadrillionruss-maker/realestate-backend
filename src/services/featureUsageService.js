// featureUsageService.js — SECTION 22, the write side.
//
// track(orgId, feature) is called from ten places across the app (see
// re_feature_events, migrations/053) — never awaited by its caller for
// anything, never allowed to fail the request that triggered it. Same
// fire-and-forget discipline as pushService.notify and every other
// side-effect helper in this codebase: a usage counter is not worth a 500.
//
// increment_feature_event is a Postgres function, not a supabase-js
// .upsert() — see the migration's own header for why an atomic "+1" can't
// be expressed through the query builder at all.

const { supabaseRaw } = require('../middleware/orgContext');

const FEATURES = [
  'brief_generated', 'payment_recorded', 'document_generated', 'agent_action',
  'portal_opened', 'whatsapp_sent', 'import_used', 'hardship_requested',
  'community_posted', 'referral_made',
];
const VALID_FEATURES = new Set(FEATURES);

async function track(orgId, feature) {
  if (!orgId || !VALID_FEATURES.has(feature)) return;
  try {
    const { error } = await supabaseRaw.rpc('increment_feature_event', {
      p_organization_id: orgId,
      p_feature: feature,
    });
    if (error) console.warn(`[featureUsage] could not record "${feature}" for org ${orgId}:`, error.message);
  } catch (err) {
    console.warn(`[featureUsage] could not record "${feature}" for org ${orgId}:`, err.message);
  }
}

module.exports = { track, FEATURES };
