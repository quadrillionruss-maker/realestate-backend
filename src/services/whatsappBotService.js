// whatsappBotService.js — SECTION 9, the buyer-facing WhatsApp mini app.
//
// A buyer messages the business number; this resolves which workspace owns
// that number, who the buyer is, what they want, and answers — all without
// a human, the same "cheapest admin saving" reasoning portalService.js
// states for its own three questions. Where portalService needs a link a
// developer sends, this needs nothing: the buyer just types.
//
// Reuses SECTION 5's outbound primitive (notificationService.sendWhatsApp/
// sendWhatsAppDocument) rather than inventing a second one — see that
// file's own comment on why it was built a section early.
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const notify = require('./notificationService');
const { createSignedUrl } = require('./documentStorage');
const { initInstallmentPayment } = require('./paystackService');
// collectionsAgent never requires this file back, so there is no cycle to
// guard against here the way documentService.js's lazy require of
// receiptService has to.
const collectionsAgent = require('./collectionsAgent');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = env.openai.briefModel;
const CLASSIFY_TIMEOUT_MS = 12_000;

const INTENTS = ['check_balance', 'next_payment', 'pay_now', 'get_receipt', 'speak_to_agent'];

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};
const fmtDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

// ── Intent classification ───────────────────────────────────────────────────
// OpenAI function calling, forced to call classify_intent — the model has no
// choice but to return one of the five names, never free text. No buyer PII
// leaves this call: only the raw message text, which the buyer themselves
// just sent to this number.
const CLASSIFY_FUNCTION = {
  name: 'classify_intent',
  description: "Classify a property buyer's WhatsApp message into exactly one intent.",
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['intent'],
    properties: {
      intent: {
        type: 'string',
        enum: INTENTS,
        description:
          'check_balance: how much they have paid/owe overall. next_payment: when/how much is next due. ' +
          'pay_now: they want to pay online right now. get_receipt: they want a copy of their receipt. ' +
          'speak_to_agent: anything else — a complaint, a question this cannot answer, or genuinely unclear.',
      },
    },
  },
};

// Used with no OPENAI_API_KEY, or if the model call fails — a buyer's
// message still gets an answer either way, degraded to keyword matching
// rather than left unanswered. Defaults to speak_to_agent, same as the
// model is instructed to: on a financial matter, an uncertain guess is
// worse than a human following up.
function keywordIntent(text) {
  const t = String(text || '').toLowerCase();
  if (/\breceipt\b/.test(t)) return 'get_receipt';
  if (/\b(pay now|payment link|pay online|make.*payment|how do i pay)\b/.test(t)) return 'pay_now';
  if (/\b(balance|how much.*owe|outstanding|total paid)\b/.test(t)) return 'check_balance';
  if (/\b(next payment|when.*due|due date|next installment)\b/.test(t)) return 'next_payment';
  return 'speak_to_agent';
}

async function classifyIntent(text) {
  if (!env.openai.apiKey) return keywordIntent(text);

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.openai.apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: "You classify a property buyer's WhatsApp message for a Nigerian real estate developer. "
              + 'Always call classify_intent exactly once. If genuinely unclear, choose speak_to_agent.',
          },
          { role: 'user', content: String(text || '').slice(0, 1000) },
        ],
        tools: [{ type: 'function', function: CLASSIFY_FUNCTION }],
        tool_choice: { type: 'function', function: { name: 'classify_intent' } },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);

    const json = await response.json();
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    const args = call?.function?.arguments ? JSON.parse(call.function.arguments) : null;
    return args?.intent && INTENTS.includes(args.intent) ? args.intent : 'speak_to_agent';
  } catch (err) {
    console.warn('[whatsapp-bot] intent classification failed, falling back to keywords:', err.message);
    return keywordIntent(text);
  }
}

// ── Buyer resolution ─────────────────────────────────────────────────────────
// Which workspace: the message's OWN phone_number_id names it directly —
// unlike Paystack's shared webhook (which has to try every known key
// because a charge event carries no org of its own), a WhatsApp Business
// number belongs to exactly one workspace, so this is a direct lookup, not
// a "try each" loop.
async function resolveOrgByPhoneNumberId(phoneNumberId) {
  const { data } = await supabaseAdmin
    .from('re_org_settings')
    .select('organization_id')
    .eq('whatsapp_phone_number_id', phoneNumberId)
    .maybeSingle();
  return data?.organization_id || null;
}

// Which buyer: re_customers.phone is free-text (however a rep typed it in),
// so an exact string match on the incoming wa_id would miss most rows. A
// LIKE on the last 10 digits narrows to a handful of candidates cheaply;
// normalizeNigerianPhone on each confirms the real match, the same
// normalization notificationService already applies before ever sending an
// SMS/WhatsApp message to a stored number.
async function findCustomerByWhatsAppNumber(orgId, fromNumber) {
  const normalizedFrom = notify.normalizeNigerianPhone(fromNumber);
  if (!normalizedFrom || normalizedFrom.length < 10) return null;
  const last10 = normalizedFrom.slice(-10);

  const { data: candidates } = await supabaseAdmin
    .from('re_customers')
    .select('id, full_name, phone, email')
    .eq('organization_id', orgId)
    .ilike('phone', `%${last10}`);

  return (candidates || []).find((c) => notify.normalizeNigerianPhone(c.phone) === normalizedFrom) || null;
}

// ── Buyer data (scoped to ACTIVE plans only — a quick chat answer, not the
// full paid-history reconciliation portalService's dashboard needs) ────────
async function loadActiveScheduleRows(orgId, customerId) {
  const { data: reservations } = await supabaseAdmin
    .from('re_reservations')
    .select(`
      id, re_units(unit_number),
      re_installment_plans(status, total_amount,
        re_installment_schedule(id, due_date, amount_due, status))
    `)
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .neq('status', 'cancelled');

  const rows = [];
  let totalContracted = 0;
  for (const reservation of reservations || []) {
    for (const plan of asArray(reservation.re_installment_plans)) {
      if (plan.status !== 'active') continue;
      totalContracted += Number(plan.total_amount || 0);
      for (const row of plan.re_installment_schedule || []) {
        rows.push({ ...row, unit_number: reservation.re_units?.unit_number, reservation_id: reservation.id });
      }
    }
  }
  return { rows, totalContracted };
}

async function handleCheckBalance(orgId, customer) {
  const { rows, totalContracted } = await loadActiveScheduleRows(orgId, customer.id);
  const totalPaid = rows.filter((r) => r.status === 'paid').reduce((sum, r) => sum + Number(r.amount_due), 0);
  const overdue = rows.filter((r) => r.status === 'overdue').reduce((sum, r) => sum + Number(r.amount_due), 0);
  const balance = Math.max(0, totalContracted - totalPaid);

  if (!totalContracted) return `Hi ${customer.full_name}, we don't have an active payment plan on file for you yet. Please contact your sales office.`;

  return `Hi ${customer.full_name}, here is your balance:\n`
    + `Contracted: ${naira(totalContracted)}\nPaid so far: ${naira(totalPaid)}\nBalance: ${naira(balance)}`
    + (overdue ? `\nOverdue: ${naira(overdue)}` : '');
}

async function handleNextPayment(orgId, customer) {
  const { rows } = await loadActiveScheduleRows(orgId, customer.id);
  const open = rows
    .filter((r) => r.status === 'pending' || r.status === 'overdue')
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

  if (!open.length) return `Hi ${customer.full_name}, you have no upcoming installments — you're fully up to date.`;

  const next = open[0];
  return `Hi ${customer.full_name}, your next payment is ${naira(next.amount_due)}, due ${fmtDate(next.due_date)}`
    + (next.unit_number ? ` for Unit ${next.unit_number}` : '')
    + (next.status === 'overdue' ? ' — this is currently overdue.' : '.');
}

async function handlePayNow(orgId, customer) {
  const { rows } = await loadActiveScheduleRows(orgId, customer.id);
  const open = rows
    .filter((r) => r.status === 'pending' || r.status === 'overdue')
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

  if (!open.length) return `Hi ${customer.full_name}, you have no outstanding installments to pay right now.`;

  const next = open[0];
  // Paystack requires SOME email on the init call — a buyer added without
  // one (phone-only is common) gets a synthetic, undeliverable-but-valid-
  // format address rather than being blocked from paying online entirely.
  const email = customer.email || `buyer-${customer.id}@no-email.archta`;
  try {
    const result = await initInstallmentPayment(orgId, next.id, email, {});
    return `Hi ${customer.full_name}, here's your payment link for ${naira(result.amount)}: ${result.authorization_url}`;
  } catch (err) {
    console.warn('[whatsapp-bot] pay_now link generation failed:', err.message);
    return `Hi ${customer.full_name}, we couldn't generate a payment link right now. Please contact your sales office.`;
  }
}

async function handleGetReceipt(orgId, customer) {
  const { data: reservations } = await supabaseAdmin
    .from('re_reservations').select('id').eq('organization_id', orgId).eq('customer_id', customer.id);
  const reservationIds = (reservations || []).map((r) => r.id);
  if (!reservationIds.length) return { text: `Hi ${customer.full_name}, we don't have any receipts on file for you yet.` };

  const { data: docs } = await supabaseAdmin
    .from('re_documents')
    .select('id, storage_path, generated_at')
    .eq('organization_id', orgId)
    .eq('doc_type', 'receipt')
    .eq('status', 'generated')
    .in('reservation_id', reservationIds)
    .order('generated_at', { ascending: false })
    .limit(1);

  const latest = docs?.[0];
  if (!latest?.storage_path) return { text: `Hi ${customer.full_name}, we don't have any receipts on file for you yet.` };

  return {
    document: { url: await createSignedUrl(latest.storage_path), filename: `Receipt-${fmtDate(latest.generated_at).replace(/\s/g, '-')}.pdf` },
  };
}

async function fileAgentRequestTask(orgId, customer, messageText) {
  const { data: reservations } = await supabaseAdmin
    .from('re_reservations')
    .select('id, sales_rep_id')
    .eq('organization_id', orgId)
    .eq('customer_id', customer.id)
    .neq('status', 'cancelled')
    .order('reserved_at', { ascending: false })
    .limit(1);
  const reservation = reservations?.[0] || null;

  let assignedUserId = null;
  let repUser = null;
  if (reservation?.sales_rep_id) {
    const { data: rep } = await supabaseAdmin
      .from('re_sales_reps').select('user_id, users(email, full_name)')
      .eq('id', reservation.sales_rep_id).maybeSingle();
    assignedUserId = rep?.user_id || null;
    repUser = rep?.users || null;
  }

  const { error } = await supabaseAdmin.from('re_tasks').insert({
    organization_id: orgId,
    assigned_to: assignedUserId,
    related_reservation_id: reservation?.id || null,
    title: `${customer.full_name} wants to speak to an agent (WhatsApp)`,
    notes: `Buyer's message: "${String(messageText || '').slice(0, 500)}"`,
    source: 'ai',
  });
  if (error) console.warn('[whatsapp-bot] could not file speak_to_agent task:', error.message);

  if (repUser?.email) {
    await notify.sendEmail({
      orgId,
      to: repUser.email,
      subject: `${customer.full_name} wants to speak with you`,
      html: notify.emailShell({
        heading: `${customer.full_name} wants to speak with you`,
        intro: `They messaged your WhatsApp business number: "${String(messageText || '').slice(0, 300)}"`,
      }),
      text: `${customer.full_name} wants to speak with you: "${messageText}"`,
      template: 'whatsapp_agent_request',
      relatedType: 're_customers',
      relatedId: customer.id,
    });
  }

  return `Thanks ${customer.full_name}, we've let your sales agent know — they'll reach out to you shortly.`;
}

// ── The one entry point routes/webhooks.js calls ────────────────────────────
// Never throws — a malformed or unexpected inbound payload must not turn an
// already-acknowledged webhook delivery into a crash. See that route's own
// comment on WHY the ack happens before this runs.
async function handleInboundMessage({ phoneNumberId, from, text }) {
  try {
    const orgId = await resolveOrgByPhoneNumberId(phoneNumberId);
    if (!orgId) {
      console.warn('[whatsapp-bot] inbound message for an unrecognised phone_number_id:', phoneNumberId);
      return;
    }

    const customer = await findCustomerByWhatsAppNumber(orgId, from);
    if (!customer) {
      await notify.sendWhatsApp({ orgId, to: from, body: 'We could not find your account. Please contact your developer directly.' });
      return;
    }

    // Standard WhatsApp Business opt-out convention — checked before
    // anything else, including a reply already in flight for another
    // reason, because dealManager.clearance() reads this same column on
    // EVERY future agent send. This one reply is the exception to "opted
    // out means no automated messages": confirming the opt-out itself.
    if (/^\s*(stop|unsubscribe)\s*$/i.test(text)) {
      await supabaseAdmin.from('re_customers').update({ whatsapp_opt_out: true }).eq('id', customer.id);
      await notify.sendWhatsApp({ orgId, to: from, body: "You've been unsubscribed from automated messages. Reply START to opt back in." });
      return;
    }
    if (/^\s*start\s*$/i.test(text) && customer.whatsapp_opt_out) {
      await supabaseAdmin.from('re_customers').update({ whatsapp_opt_out: false }).eq('id', customer.id);
      await notify.sendWhatsApp({ orgId, to: from, body: "You're subscribed to automated messages again." });
      return;
    }

    // SECTION 11 — a reply to a collections conversation ("I will pay
    // Friday", "already paid", "can't pay") means something specific that
    // none of the five mini-app intents below capture; checked first so it
    // takes priority over the general classifier for exactly those phrasings.
    const collectionsResult = await collectionsAgent.parseReply(orgId, customer, text);
    if (collectionsResult.handled) {
      await notify.sendWhatsApp({
        orgId, to: from, body: collectionsResult.reply,
        template: 'whatsapp_bot_reply', relatedType: 're_customers', relatedId: customer.id,
      });
      return;
    }

    const intent = await classifyIntent(text);

    if (intent === 'get_receipt') {
      const result = await handleGetReceipt(orgId, customer);
      if (result.document) {
        await notify.sendWhatsAppDocument({
          orgId, to: from, mediaUrl: result.document.url, filename: result.document.filename,
          caption: 'Your receipt', template: 'whatsapp_receipt', relatedType: 're_customers', relatedId: customer.id,
        });
      } else {
        await notify.sendWhatsApp({ orgId, to: from, body: result.text, template: 'whatsapp_bot_reply', relatedType: 're_customers', relatedId: customer.id });
      }
      return;
    }

    const HANDLERS = {
      check_balance: handleCheckBalance,
      next_payment: handleNextPayment,
      pay_now: handlePayNow,
      speak_to_agent: (o, c) => fileAgentRequestTask(o, c, text),
    };

    const reply = await HANDLERS[intent](orgId, customer);
    await notify.sendWhatsApp({
      orgId, to: from, body: reply,
      template: 'whatsapp_bot_reply', relatedType: 're_customers', relatedId: customer.id,
    });
  } catch (err) {
    console.error('[whatsapp-bot] could not process inbound message:', err.message);
  }
}

module.exports = {
  INTENTS,
  classifyIntent,
  keywordIntent,
  resolveOrgByPhoneNumberId,
  findCustomerByWhatsAppNumber,
  handleInboundMessage,
};
