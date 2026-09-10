// salesAgent.js — SECTION 11, v2's Sales Agent.
//
// The product spec describes three separate lead signals — "just added",
// "enquired about a unit but hasn't reserved", "stage-0 lead with no
// contact" — but this schema tracks none of "enquired about a unit" or "a
// lead's own contact stage" as a real fact (escalation_stage lives on
// re_reservations and tracks payment lateness; a lead with no reservation
// has no reservation to carry one). The one real signal every
// not-yet-converted buyer DOES have is re_customers.created_at, so all
// three buckets are read off lead age instead: 0-3 days → welcome,
// 3-7 days → follow-up, 7+ days → a gentle check-in. Documented here rather
// than silently reinterpreted, the same way documentAgent.js notes its own
// "allocation letter" → SIGNABLE_DOC_TYPES mapping.
const { supabaseAdmin } = require('../middleware/orgContext');
const { mapWithConcurrency } = require('../utils/concurrency');
const dealManager = require('./dealManager');

const AGENT_NAME = 'sales_agent';
const MAX_MESSAGES_PER_LEAD = 3;
const TEMPLATES = {
  welcome: 'sales_agent_welcome',
  followup: 'sales_agent_followup',
  checkin: 'sales_agent_checkin',
};
// AUDIT FIX (A7/P3) — run() used to fetch every re_customers row this org
// has ever had, unfiltered and unlimited, in one request — a read that
// grows forever as an org's total buyer count grows, the same class of
// problem migrations/010's distinct_reservation_org_ids() was written to
// fix for the org-enumeration side of this same daily job. LEAD_PAGE_SIZE
// pages through it instead.
const LEAD_PAGE_SIZE = 500;
// Same concurrency jobs/daily.js's own per-org loop and collectionsAgent.js
// use — a WhatsApp send or a database round trip per lead, run one at a
// time, turned a large org's morning sweep into minutes of serial network
// waiting that could have overlapped.
const LEAD_CONCURRENCY = 4;

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

// A budget-matched pick would need a budget this product does not collect
// from a lead — the cheapest few available units stand in as "a range worth
// looking at" rather than this agent guessing at an affordability figure
// nobody gave it.
async function availableUnitsBlurb(orgId) {
  const { data: units } = await supabaseAdmin
    .from('re_units')
    .select('unit_number, list_price, re_projects(name)')
    .eq('organization_id', orgId)
    .eq('status', 'available')
    .order('list_price', { ascending: true })
    .limit(3);

  if (!units?.length) return null;
  return units.map((u) => `${u.re_projects?.name || 'Unit'} ${u.unit_number} (${naira(u.list_price)})`).join(', ');
}

// Every message this agent has EVER sent this lead, regardless of which of
// the three templates — the cap is on total outreach to an unconverted
// lead, not per-template.
async function messageCountForLead(orgId, customerId) {
  const { data } = await supabaseAdmin
    .from('re_notifications')
    .select('id')
    .eq('organization_id', orgId)
    .eq('channel', 'whatsapp')
    .eq('related_type', 're_customers')
    .eq('related_id', customerId)
    .in('template', Object.values(TEMPLATES));
  return data?.length || 0;
}

function bucketFor(ageDays) {
  if (ageDays < 3) return 'welcome';
  if (ageDays < 7) return 'followup';
  return 'checkin';
}

// Pages through the org's full customer list rather than one unbounded
// select — see LEAD_PAGE_SIZE's own comment above.
async function fetchAllLeads(orgId) {
  const leads = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .select('id, full_name, phone, whatsapp_opt_out, created_at, re_reservations(status)')
      .eq('organization_id', orgId)
      .order('id', { ascending: true })
      .range(offset, offset + LEAD_PAGE_SIZE - 1);
    if (error) throw error;
    leads.push(...(data || []));
    if (!data || data.length < LEAD_PAGE_SIZE) break;
    offset += LEAD_PAGE_SIZE;
  }
  return leads;
}

async function run(orgId) {
  const leads = await fetchAllLeads(orgId);

  const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
  const unconverted = leads.filter(
    (c) => c.phone && !asArray(c.re_reservations).some((r) => r.status !== 'cancelled')
  );
  if (!unconverted.length) return { sent: 0 };

  const unitsBlurb = await availableUnitsBlurb(orgId);
  const now = Date.now();
  let sent = 0;

  // AUDIT FIX (A7/P3) — this used to be a plain `for...of`, one lead's
  // message-count lookup and WhatsApp send waited on before the next lead's
  // even started. LEAD_CONCURRENCY lanes pulling from the same list, same
  // pattern as jobs/daily.js's own per-org loop and collectionsAgent.js.
  await mapWithConcurrency(unconverted, LEAD_CONCURRENCY, async (lead) => {
    const count = await messageCountForLead(orgId, lead.id);
    if (count >= MAX_MESSAGES_PER_LEAD) return;

    const ageDays = (now - Date.parse(lead.created_at)) / 86_400_000;
    const bucket = bucketFor(ageDays);
    const template = TEMPLATES[bucket];

    const body = bucket === 'welcome'
      ? `Hi ${lead.full_name}, thanks for your interest!`
        + (unitsBlurb ? ` Some units currently available: ${unitsBlurb}.` : '')
        + ' Reply to this message and we will help you find the right fit.'
      : bucket === 'followup'
        ? `Hi ${lead.full_name}, just checking in — are you still interested in one of our units? We are happy to answer any questions.`
        : `Hi ${lead.full_name}, it has been a little while — still house-hunting? Let us know if there is anything we can help with.`;

    // Only the bucket this lead currently falls in fires per run —
    // dealManager's own per-template "already sent today" check additionally
    // stops the SAME bucket firing twice were the cron ever to run twice in
    // one day.
    const result = await dealManager.sendWithClearance(orgId, AGENT_NAME, lead, {
      template, body, actionType: `lead_${bucket}`,
    });
    if (result?.status === 'sent') sent += 1;
  });

  return { sent };
}

module.exports = { run, bucketFor, messageCountForLead, MAX_MESSAGES_PER_LEAD, TEMPLATES };
