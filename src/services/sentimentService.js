// sentimentService.js — SECTION 13 (feature expansion): classifying a
// buyer's own inbound message (buyer portal or WhatsApp) as positive,
// neutral, concerned, or at_risk.
//
// Same OpenAI function-calling shape as whatsappBotService.js's
// classifyIntent — forced to call one function, so the model has no choice
// but to return one of the four labels, never free text — and the same
// keyword fallback philosophy every AI feature in this product already
// follows: no OPENAI_API_KEY, or a failed call, degrades to a rule-based
// guess rather than leaving latest_sentiment unset.
//
// CACHING: re_sentiment_cache is keyed by a hash of the message text itself
// (migrations/062's own header explains why it is not scoped per
// workspace) — the exact same message is never sent to OpenAI twice,
// whether that repeat came from the same buyer or a different one in a
// different workspace.
const crypto = require('crypto');
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = env.openai.briefModel;
const CLASSIFY_TIMEOUT_MS = 12_000;

const SENTIMENTS = ['positive', 'neutral', 'concerned', 'at_risk'];

const CLASSIFY_FUNCTION = {
  name: 'classify_sentiment',
  description: "Classify a property buyer's message for a Nigerian real estate developer into exactly one sentiment.",
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['sentiment'],
    properties: {
      sentiment: {
        type: 'string',
        enum: SENTIMENTS,
        description:
          'positive: happy, thankful, satisfied. neutral: a plain question or statement with no emotional charge. '
          + 'concerned: worried, confused, or mildly frustrated but not hostile. '
          + 'at_risk: angry, threatening to walk away, mentions a refund/lawyer/cancelling, or otherwise reads like '
          + 'this buyer relationship is at risk.',
      },
    },
  },
};

// Used with no OPENAI_API_KEY, or if the model call fails. Deliberately
// simple — a handful of clear signal words rather than anything that could
// itself misjudge a buyer's tone with false confidence.
const AT_RISK_RE = /\b(lawyer|refund|cancel|scam|fraud|report you|legal action|disappointed|unacceptable|angry|furious)\b/i;
const CONCERNED_RE = /\b(worried|confused|not sure|please help|urgent|problem|issue|delay|when will|why (has|is|hasn'?t))\b/i;
const POSITIVE_RE = /\b(thank|thanks|great|appreciate|happy|excellent|wonderful|good job|well done)\b/i;

function keywordSentiment(text) {
  const t = String(text || '');
  if (AT_RISK_RE.test(t)) return 'at_risk';
  if (CONCERNED_RE.test(t)) return 'concerned';
  if (POSITIVE_RE.test(t)) return 'positive';
  return 'neutral';
}

async function classifySentiment(text) {
  if (!env.openai.apiKey) return keywordSentiment(text);

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
            content: 'You classify the emotional tone of a property buyer\'s message for a Nigerian real estate '
              + 'developer. Always call classify_sentiment exactly once.',
          },
          { role: 'user', content: String(text || '').slice(0, 1000) },
        ],
        tools: [{ type: 'function', function: CLASSIFY_FUNCTION }],
        tool_choice: { type: 'function', function: { name: 'classify_sentiment' } },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);

    const json = await response.json();
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    const args = call?.function?.arguments ? JSON.parse(call.function.arguments) : null;
    return args?.sentiment && SENTIMENTS.includes(args.sentiment) ? args.sentiment : keywordSentiment(text);
  } catch (err) {
    console.warn('[sentiment] classification failed, falling back to keywords:', err.message);
    return keywordSentiment(text);
  }
}

function hashMessage(text) {
  return crypto.createHash('sha256').update(String(text || '').trim().toLowerCase()).digest('hex');
}

// The one entry point callers use — classifies once per distinct message
// text, ever, regardless of who sent it or from which workspace.
async function classifyAndCache(text) {
  const hash = hashMessage(text);

  const { data: cached } = await supabaseAdmin
    .from('re_sentiment_cache').select('sentiment').eq('message_hash', hash).maybeSingle();
  if (cached) return cached.sentiment;

  const sentiment = await classifySentiment(text);

  // Best-effort — a cache write failing must not stop the classification
  // itself from being used and stored on the buyer's own record.
  try {
    await supabaseAdmin.from('re_sentiment_cache').upsert({ message_hash: hash, sentiment }, { onConflict: 'message_hash' });
  } catch (err) {
    console.warn('[sentiment] could not cache classification:', err.message);
  }

  return sentiment;
}

// Called from portalService/messageService (a buyer portal message) and
// whatsappBotService (an inbound WhatsApp reply) after every inbound
// message — never throws, same rule every other derived-figure recompute
// in this product follows.
async function updateCustomerSentiment(orgId, customerId, text) {
  if (!orgId || !customerId || !String(text || '').trim()) return null;
  try {
    const sentiment = await classifyAndCache(text);
    await supabaseAdmin
      .from('re_customers').update({ latest_sentiment: sentiment })
      .eq('id', customerId).eq('organization_id', orgId);
    return sentiment;
  } catch (err) {
    console.warn('[sentiment] could not update customer sentiment:', err.message);
    return null;
  }
}

// The morning brief's "flagged as at-risk based on recent messages" list —
// mirrors defaultRiskService.topDefaultRisks' own shape (a small,
// deterministic, code-computed list attached to the brief payload rather
// than something asked of the model — see aiBrief.js's own comment on that
// architecture choice).
async function atRiskSentimentBuyers(orgId, limit = 5) {
  const { data, error } = await supabaseAdmin
    .from('re_customers')
    .select('id, full_name')
    .eq('organization_id', orgId)
    .eq('latest_sentiment', 'at_risk')
    .limit(limit);
  if (error) throw error;
  return (data || []).map((c) => ({ customer_id: c.id, customer_name: c.full_name || 'Unknown buyer' }));
}

module.exports = {
  SENTIMENTS, keywordSentiment, classifySentiment, classifyAndCache, updateCustomerSentiment, hashMessage,
  atRiskSentimentBuyers,
};
