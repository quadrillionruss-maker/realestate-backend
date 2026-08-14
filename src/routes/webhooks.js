// routes/webhooks.js — the endpoint Paystack posts to.
//
// handleRealEstateCharge() has existed since v1 and correctly settles an
// installment from a charge.success event. Nothing called it. A developer
// could generate a payment link, the buyer could pay, and the schedule would
// sit there untouched until someone re-recorded the payment by hand as if it
// were a bank transfer — which defeats the entire point of the integration.
//
// ── This route is UNAUTHENTICATED, and that is the whole problem ───────────
// Paystack does not hold a bearer token. What it does hold is HMAC-SHA512 of
// the exact request body, keyed with the Paystack secret. So:
//
//   1. The body is read RAW. JSON.parse then re-stringify does not round-trip
//      byte for byte — key order and whitespace both move — and the signature
//      is over bytes. server.js therefore mounts express.raw() here, BEFORE
//      the global express.json().
//   2. The signature is compared in constant time. A byte-by-byte early exit
//      leaks the correct prefix to anyone willing to time it.
//   3. Only then is the body parsed, and only charge.success is acted on.
//
// ── Why it answers 200 to almost everything ───────────────────────────────
// Paystack retries any non-2xx with backoff for hours. A 500 caused by a bug
// in our handler becomes a stream of retries of an event we will never
// process. So a verified event is acknowledged once it has been *received*;
// failures after that point are logged and dealt with here, not by making
// Paystack shout. An UNVERIFIED request is a different matter and gets a 401.

const express = require('express');
const env = require('../config/env');
const {
  handleRealEstateCharge, verifyWebhookSignature, parseInstallmentReference,
} = require('../services/paystackService');
const { supabaseAdmin } = require('../middleware/orgContext');
const { onPaymentRecorded } = require('../services/paymentEvents');
const { auditSystem } = require('../services/auditService');
const { handleInboundMessage } = require('../services/whatsappBotService');

const router = express.Router();

// A class of Postgres error that will fail EXACTLY the same way no matter
// how many times Paystack retries it — a malformed or impossible event, not
// a transient database hiccup. See the catch block below for why these get a
// 200 instead of the usual 500.
const PERMANENT_PG_ERROR_CODES = new Set([
  '23514', // check_violation — a value the schema flatly refuses
  '23502', // not_null_violation — a required field the event never carried
  '22P02', // invalid_text_representation — a value that doesn't even parse as its column's type
]);

router.post('/paystack', async (req, res) => {
  // express.raw leaves a Buffer here. If some other body parser got there
  // first, this is an object and the signature can no longer be verified —
  // fail closed rather than trusting an unverifiable event.
  if (!Buffer.isBuffer(req.body)) {
    console.error('[webhook] raw body missing — check middleware order in server.js');
    return res.status(500).json({ error: 'Webhook misconfigured.' });
  }

  // One shared endpoint, now signed by as many distinct Paystack accounts as
  // workspaces have configured their own — verifyWebhookSignature tries every
  // known key (the platform's, plus every workspace's own) and trusts nothing
  // about the body until one of them actually matches. See that function's
  // own comment for why the order matters: picking a key based on the
  // (unverified) reference first would let an unauthenticated request force a
  // database lookup with no proof of anything, which this order never does.
  //
  // verifyWebhookSignature returns { verified, matchedOrgId }, not a bare
  // boolean — an object is always truthy in JS, so `!(await ...)` here would
  // silently stop rejecting anything at all. `.verified` is read explicitly,
  // and the WHOLE object is carried forward to handleRealEstateCharge below,
  // which needs `.matchedOrgId` to refuse a workspace-key-signed event that
  // names a different org's schedule (see that function's own comment).
  const verification = await verifyWebhookSignature(req.body, req.headers['x-paystack-signature']);
  if (!verification.verified) {
    console.warn('[webhook] rejected an unsigned or mis-signed Paystack request');
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Body is not valid JSON.' });
  }

  if (event.event !== 'charge.success') {
    // Nothing durable to write for any other event type — safe to acknowledge
    // immediately, same as before.
    return res.status(200).json({ received: true });
  }

  const reference = event.data?.reference;

  // handleRealEstateCharge returns a bare `true` both when it just inserted a
  // brand-new payment row AND when the reference already existed (a Paystack
  // retry of an event this endpoint already durably recorded) — the two
  // cases are indistinguishable from its return value alone. Re-running the
  // full post-payment chain below (receipt PDF, commission accrual, buyer
  // email/SMS, audit entry) on a retry would re-send the receipt and write a
  // duplicate audit row for money that was already accounted for once.
  //
  // Checked HERE, before calling it, rather than trusting anything about
  // handleRealEstateCharge's own return shape — that function is owned by a
  // different fix in this codebase and its signature is not this route's to
  // assume. A plain existence check against re_payments is the same signal
  // handleRealEstateCharge itself uses internally for its own idempotency
  // fast path (see paystackService.js), so this mirrors, rather than
  // duplicates, that logic.
  let alreadyRecorded = false;
  if (reference) {
    const { data: existingPayment } = await supabaseAdmin
      .from('re_payments')
      .select('id')
      .eq('paystack_reference', reference)
      .maybeSingle();
    alreadyRecorded = Boolean(existingPayment);
  }

  let owned;
  try {
    // handleRealEstateCharge returns false for references this product does
    // not own (shared endpoint) and true once the payment row is durably
    // written — or throws on a genuine, transient write failure. The ack
    // below happens only after this settles, on purpose: acking first and
    // writing after (the previous design) meant a transient DB error here
    // permanently lost a real payment, because Paystack never retries an
    // event it already got a 200 for. Duplicate deliveries are already
    // handled inside handleRealEstateCharge (23505 / existing-reference
    // checks both resolve to `true`, not a throw), so retrying a slow-but-
    // eventually-successful write is safe, not wasteful.
    //
    // `verification` is passed through as the second argument so the
    // cross-workspace org-binding check inside handleRealEstateCharge can
    // actually run — omitting it defaults to no check at all (see that
    // function's own comment on its `verification = null` default).
    owned = await handleRealEstateCharge(event, verification);
  } catch (err) {
    // err.message only — a raw Postgres error's .detail/.hint frequently
    // quotes the offending row's actual values (a buyer's email, a phone
    // number) back verbatim, and this log line has no business carrying that
    // into wherever these logs end up retained.
    console.error('[webhook] failed to record charge.success, asking Paystack to retry:', err.message);
    if (env.isDev) console.error(err.stack);

    // A check/not-null/invalid-type violation on THIS event will fail
    // identically forever — Paystack would otherwise retry an event that can
    // never succeed for hours, which is worse than the alternative: log it
    // loudly, leave a clear trail for a human, and stop the retry storm with
    // a 200. Anything else (a dropped connection, a momentary timeout) keeps
    // returning 500 exactly as before, because those genuinely might succeed
    // on the next attempt.
    if (PERMANENT_PG_ERROR_CODES.has(err.code)) {
      console.error(
        '[webhook] PERMANENT failure (pg code %s) for reference %s — acknowledging to stop Paystack retries; this payment was NOT recorded and needs manual review. %s',
        err.code, reference, err.message
      );
      try {
        const parsed = parseInstallmentReference(reference);
        const { data: scheduleOrg } = parsed
          ? await supabaseAdmin
              .from('re_installment_schedule')
              .select('organization_id')
              .eq('id', parsed.scheduleId)
              .maybeSingle()
          : { data: null };
        // Only writeable if the org can actually be established — same
        // reasoning as the side-effect catch block below: an audit row with
        // no organization_id is noise in a table whose whole value is that
        // every row traces to a workspace.
        if (scheduleOrg?.organization_id) {
          await auditSystem({
            orgId: scheduleOrg.organization_id,
            action: 'webhook.charge_failed_permanently',
            entityType: 're_payments',
            summary: `Paystack charge.success for ${reference} failed permanently (${err.code}) and was NOT recorded — needs manual review`,
            metadata: { reference, pg_code: err.code, message: err.message },
          });
        }
      } catch (auditErr) {
        console.error('[webhook] could not even write the manual-review audit entry:', auditErr.message);
      }
      return res.status(200).json({ received: true });
    }

    return res.status(500).json({ error: 'Could not record this payment yet.' });
  }

  // The payment is durably in the database (or this reference genuinely is
  // not ours) — safe to acknowledge now. Everything from here is best-effort
  // side-effects around money that is already safely recorded: a failure in
  // the receipt, the commission accrual or the buyer notification must never
  // turn an already-recorded payment into a Paystack retry.
  res.status(200).json({ received: true });
  if (!owned) return;
  if (alreadyRecorded) {
    // A retry of an event already durably recorded — acknowledged above, but
    // the receipt/commission/notification/audit chain must run exactly once
    // per real payment, not once per delivery attempt.
    console.info('[webhook] charge.success for', reference, 'was already recorded — skipping side effects on this retry');
    return;
  }

  try {
    // The handler inserts the payment row; find it so the same post-payment
    // work runs as for a manually recorded transfer — receipt, commission,
    // notification, audit. Before this, a card payment produced none of it.
    const { data: payment } = await supabaseAdmin
      .from('re_payments')
      .select('id, organization_id, overpayment')
      .eq('paystack_reference', reference)
      .maybeSingle();

    if (!payment) {
      console.warn('[webhook] charge.success settled nothing for', reference);
      return;
    }

    await onPaymentRecorded({
      orgId: payment.organization_id,
      paymentId: payment.id,
      source: 'paystack',
      overpayment: payment.overpayment,
    });
  } catch (err) {
    // The response has already gone, so there is nowhere to surface this but
    // the log. Shout: this is the class of failure that otherwise reaches the
    // developer as a buyer insisting they paid. It is deliberately NOT written
    // to re_audit_log — the org this event belonged to is exactly what we
    // failed to establish, and an audit row with no organization_id is noise
    // in a table whose value is that every row can be traced to a workspace.
    console.error('[webhook] failed processing charge.success side effects:', err.message);
    if (env.isDev) console.error(err.stack);
  }
});

// ── WhatsApp (SECTION 9) ─────────────────────────────────────────────────
// Meta's one-time verification handshake, run when the webhook URL is first
// entered into the Meta App dashboard (and whenever it's re-verified) — a
// GET carrying hub.mode/hub.verify_token/hub.challenge as QUERY PARAMS, so
// this needs no body parsing at all, raw or otherwise. Echoing back
// hub.challenge is what tells Meta "yes, I am the owner of this URL";
// anything else (a wrong or missing token) is refused.
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && env.whatsapp.verifyToken && token === env.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Verification failed.' });
});

// Meta requires a fast 2xx ack regardless of what the message turns out to
// need — same shape as the Paystack handler above: acknowledge once the
// event is durably understood, then do the actual work (looking up the
// buyer, classifying intent, replying) as best-effort afterward, so a slow
// OpenAI call or a WhatsApp send failure never turns into Meta re-delivering
// the same inbound message.
//
// UNAUTHENTICATED, same reasoning as /paystack: Meta does not hold a bearer
// token. Unlike Paystack there is no HMAC signature verified here yet — this
// mirrors the shipped default (Meta's X-Hub-Signature-256 is opt-in per App
// and requires the App Secret, a fourth credential this product does not
// yet collect); resolveOrgByPhoneNumberId still means an attacker can only
// ever address ONE workspace's phone_number_id per forged request, not
// reach arbitrary org data.
router.post('/whatsapp', async (req, res) => {
  let body;
  try {
    body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {}));
  } catch {
    return res.status(400).json({ error: 'Body is not valid JSON.' });
  }

  res.status(200).json({ received: true });

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        for (const message of value.messages || []) {
          // Only plain text is handled — a buyer sending a voice note or an
          // image gets no reply rather than a crash on a field that isn't
          // there; message.text is absent for every other message type.
          const text = message.text?.body;
          if (!phoneNumberId || !message.from || !text) continue;
          await handleInboundMessage({ phoneNumberId, from: message.from, text });
        }
      }
    }
  } catch (err) {
    console.error('[webhook] failed processing inbound WhatsApp message:', err.message);
  }
});

module.exports = router;
// Attached to the exported router purely for the offline test suite — see
// reservations.js's identical pattern for stripFinancials.
module.exports.PERMANENT_PG_ERROR_CODES = PERMANENT_PG_ERROR_CODES;
