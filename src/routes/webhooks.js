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
const crypto = require('crypto');
const env = require('../config/env');
const { handleRealEstateCharge } = require('../services/paystackService');
const { supabaseAdmin } = require('../middleware/orgContext');
const { onPaymentRecorded } = require('../services/paymentEvents');
const { auditSystem } = require('../services/auditService');

const router = express.Router();

function signatureMatches(rawBody, header) {
  if (!header || !env.paystack.secretKey) return false;

  const expected = crypto
    .createHmac('sha512', env.paystack.secretKey)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(header), 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a signal —
  // check length first and return the same false either way.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/paystack', async (req, res) => {
  // express.raw leaves a Buffer here. If some other body parser got there
  // first, this is an object and the signature can no longer be verified —
  // fail closed rather than trusting an unverifiable event.
  if (!Buffer.isBuffer(req.body)) {
    console.error('[webhook] raw body missing — check middleware order in server.js');
    return res.status(500).json({ error: 'Webhook misconfigured.' });
  }

  if (!env.paystack.secretKey) {
    // Without the secret there is no way to tell Paystack from anyone else.
    return res.status(503).json({ error: 'Paystack is not configured on this server.' });
  }

  if (!signatureMatches(req.body, req.headers['x-paystack-signature'])) {
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
    owned = await handleRealEstateCharge(event);
  } catch (err) {
    // err.message only — a raw Postgres error's .detail/.hint frequently
    // quotes the offending row's actual values (a buyer's email, a phone
    // number) back verbatim, and this log line has no business carrying that
    // into wherever these logs end up retained.
    console.error('[webhook] failed to record charge.success, asking Paystack to retry:', err.message);
    if (env.isDev) console.error(err.stack);
    return res.status(500).json({ error: 'Could not record this payment yet.' });
  }

  // The payment is durably in the database (or this reference genuinely is
  // not ours) — safe to acknowledge now. Everything from here is best-effort
  // side-effects around money that is already safely recorded: a failure in
  // the receipt, the commission accrual or the buyer notification must never
  // turn an already-recorded payment into a Paystack retry.
  res.status(200).json({ received: true });
  if (!owned) return;

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

module.exports = router;
