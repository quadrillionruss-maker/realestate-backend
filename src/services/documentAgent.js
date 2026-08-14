// documentAgent.js — SECTION 11, v2's Document Agent.
//
// Scoped to documentService.SIGNABLE_DOC_TYPES (deed_of_assignment,
// subscriber_agreement, power_of_attorney) — the product spec describes
// this in terms of "allocation letter", but SECTION 8 deliberately never
// gave allocation letters a signature at all (they're informational, sent
// developer→buyer, nothing for the buyer to countersign — see
// documentService.js's own comment on why signing is scoped to exactly
// those three types). A signed_at check only means anything for a document
// that can HAVE one.
const { supabaseAdmin } = require('../middleware/orgContext');
const dealManager = require('./dealManager');
const documents = require('./documentService');
const { lagosToday } = require('./overdueService');

const AGENT_NAME = 'document_agent';
const REMINDER_INTERVAL_DAYS = 7;
const HIGH_PRIORITY_AFTER_DAYS = 21;
const REMINDER_TEMPLATE = 'document_agent_reminder';

const daysSince = (dateStr) => Math.floor((Date.now() - Date.parse(dateStr)) / 86_400_000);

// Per-DOCUMENT, 7-day cadence — a different shape from
// dealManager.clearance()'s own "already sent today" check (per CUSTOMER,
// same calendar day), so this is checked directly rather than folded into
// that generic gate. dealManager is still the one that actually sends (see
// below), for the other three checks — configured/human-handling/opted-out
// — which this agent has no reason to reimplement.
async function daysSinceLastReminder(orgId, documentId) {
  const { data } = await supabaseAdmin
    .from('re_notifications')
    .select('created_at')
    .eq('organization_id', orgId)
    .eq('channel', 'whatsapp')
    .eq('related_type', 're_documents')
    .eq('related_id', documentId)
    .eq('template', REMINDER_TEMPLATE)
    .order('created_at', { ascending: false })
    .limit(1);
  const last = data?.[0];
  return last ? daysSince(last.created_at) : Infinity;
}

async function run(orgId) {
  const { data: docs, error } = await supabaseAdmin
    .from('re_documents')
    .select(`
      id, doc_type, status, generated_at,
      re_reservations(customer_id, re_customers(id, full_name, phone, whatsapp_opt_out))
    `)
    .eq('organization_id', orgId)
    .in('doc_type', documents.SIGNABLE_DOC_TYPES)
    .in('status', ['generated', 'sent'])
    .is('signed_at', null);
  if (error) throw error;

  let remindersSent = 0;
  const highPriority = [];

  for (const doc of docs || []) {
    const customer = doc.re_reservations?.re_customers;
    if (!customer || !doc.generated_at) continue;

    const ageDays = daysSince(doc.generated_at);
    if (ageDays >= HIGH_PRIORITY_AFTER_DAYS) {
      highPriority.push({
        document_id: doc.id, doc_type: doc.doc_type,
        customer_name: customer.full_name, days_unsigned: ageDays,
      });
    }

    if ((await daysSinceLastReminder(orgId, doc.id)) < REMINDER_INTERVAL_DAYS) continue;

    const signingUrl = documents.issueSigningUrl({ id: doc.id, organization_id: orgId });
    if (!signingUrl) continue; // no APP_URL configured — nothing usable to send

    const label = doc.doc_type.replace(/_/g, ' ');
    const body = `Hi ${customer.full_name}, a friendly reminder — your ${label} is still waiting for your signature: ${signingUrl}`;

    const result = await dealManager.sendWithClearance(orgId, AGENT_NAME, customer, {
      template: REMINDER_TEMPLATE,
      body,
      actionType: 'signature_reminder',
      relatedType: 're_documents',
      relatedId: doc.id,
    });
    if (result?.status === 'sent') remindersSent += 1;
  }

  // "Flag in the brief as high priority" — that day's re_ai_briefs row
  // already exists by the time this agent runs (jobs/daily.js generates it
  // first), so this appends to the SAME row rather than writing a second,
  // competing source of truth for what the brief says. Not part of
  // BRIEF_SCHEMA (that only constrains what the MODEL returns at generation
  // time) — payload is plain JSONB, and screens.js's brief card reads this
  // key defensively, same as any optional field.
  if (highPriority.length) {
    const { data: brief } = await supabaseAdmin
      .from('re_ai_briefs').select('id, payload')
      .eq('organization_id', orgId).eq('brief_date', lagosToday()).maybeSingle();
    if (brief) {
      await supabaseAdmin
        .from('re_ai_briefs')
        .update({ payload: { ...brief.payload, high_priority_documents: highPriority } })
        .eq('id', brief.id);
    }
  }

  return { reminders_sent: remindersSent, high_priority: highPriority };
}

module.exports = { run, daysSinceLastReminder, REMINDER_INTERVAL_DAYS, HIGH_PRIORITY_AFTER_DAYS };
