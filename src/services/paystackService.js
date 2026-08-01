// paystackService.js — the only file in this module that knows Paystack exists.
//
// Every transaction reference is namespaced `REINST-<schedule uuid>-<timestamp>`.
// That namespacing means handleRealEstateCharge() can be called from a webhook
// shared with another product on the same Paystack account: it returns false
// for references it does not own, so the other product's logic proceeds
// untouched, and no second endpoint is needed.

const crypto = require('crypto');
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { isPastDue } = require('./overdueService');
const { decrypt } = require('../utils/credentials');

const PAYSTACK_BASE = 'https://api.paystack.co';
const REFERENCE_PREFIX = 'REINST-';

// ── Per-workspace keys ───────────────────────────────────────────────────
// A workspace with its own Paystack account uses ITS key for every payment
// operation; one that has never configured one keeps using the platform's
// own PAYSTACK_SECRET_KEY, exactly as before this feature existed.
async function resolvePaystackSecretKey(orgId) {
  const { data } = await supabaseAdmin
    .from('re_org_settings')
    .select('paystack_secret_key_encrypted')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (data?.paystack_secret_key_encrypted) {
    try {
      return decrypt(data.paystack_secret_key_encrypted);
    } catch (err) {
      // Decryption failing (a bad CREDENTIALS_ENCRYPTION_KEY, a corrupted
      // row) must not silently fall back to charging through the PLATFORM's
      // own Paystack account on this org's behalf — that would settle a
      // buyer's money into the wrong business. Fail the payment instead.
      console.error('[re-paystack] could not decrypt org Paystack key:', err.message);
      throw Object.assign(new Error('This workspace\'s Paystack key could not be read. Contact support.'), { statusCode: 500 });
    }
  }
  return env.paystack.secretKey || null;
}

// The webhook has the opposite problem: an incoming charge.success carries
// no organization_id until AFTER its signature is trusted, and a shared
// endpoint now receives events signed by however many distinct Paystack
// accounts workspaces have configured. The only safe order of operations is
// to try every KNOWN key against the signature and trust nothing about the
// body until one actually matches — see CLAUDE.md's "Roles and permissions"
// neighbour section, "Per-workspace credentials", for why looking at the
// reference first (to decide which key to check) would be backwards: it
// would let an unauthenticated caller force a database lookup with no proof
// of anything, which today's single-key check rejects before touching the
// database at all.
//
// HMAC-SHA512 against N keys is microseconds each — cheap enough that this
// scales fine to however many workspaces actually configure their own
// account, which will never be a large fraction of "every webhook Paystack
// ever sends this endpoint".
async function allConfiguredSecretKeys() {
  const keys = [];
  if (env.paystack.secretKey) keys.push(env.paystack.secretKey);

  const { data } = await supabaseAdmin
    .from('re_org_settings')
    .select('paystack_secret_key_encrypted')
    .not('paystack_secret_key_encrypted', 'is', null);

  for (const row of data || []) {
    try {
      const key = decrypt(row.paystack_secret_key_encrypted);
      if (key) keys.push(key);
    } catch (err) {
      // One workspace's corrupted key must not take down webhook processing
      // for every other workspace — skip it, log it, move on.
      console.warn('[re-paystack] skipping an org Paystack key that failed to decrypt:', err.message);
    }
  }
  return keys;
}

// Returns true the moment ANY known key's HMAC matches — constant-time per
// comparison, same as the single-key check this replaces, so which key
// (if any) matched is not observable by timing.
async function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const provided = Buffer.from(String(signatureHeader), 'utf8');

  for (const key of await allConfiguredSecretKeys()) {
    const expected = Buffer.from(
      crypto.createHmac('sha512', key).update(rawBody).digest('hex'), 'utf8'
    );
    if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
      return true;
    }
  }
  return false;
}

// The Settings "test these keys" button. A read-only, no-side-effect call
// that only succeeds with a genuinely valid secret key — listing (at most)
// one transaction creates nothing and costs nothing, unlike initializing a
// real charge just to see if the key works.
async function verifyPaystackKey(secretKey) {
  if (!secretKey) return { valid: false, reason: 'No key provided.' };

  let response;
  try {
    response = await fetch(`${PAYSTACK_BASE}/transaction?perPage=1`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { valid: false, reason: 'Paystack is not responding right now. Try again shortly.' };
  }

  if (response.status === 401) return { valid: false, reason: 'Paystack rejected this key — check it was copied in full.' };
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.status === false) {
    return { valid: false, reason: json.message || `Paystack returned ${response.status}.` };
  }
  return { valid: true };
}

// A schedule id is a UUID, which itself contains '-'. Splitting the reference
// on '-' therefore yields a UUID fragment, not the id — match the whole shape
// instead.
const REFERENCE_PATTERN = /^REINST-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/i;

const buildReference = (scheduleId) => `${REFERENCE_PREFIX}${scheduleId}-${Date.now()}`;

const isRealEstateReference = (reference) =>
  typeof reference === 'string' && reference.startsWith(REFERENCE_PREFIX);

function parseInstallmentReference(reference) {
  const match = REFERENCE_PATTERN.exec(String(reference || ''));
  return match ? { scheduleId: match[1], issuedAt: Number(match[2]) } : null;
}

const toKobo = (naira) => Math.round(Number(naira) * 100);
const toNaira = (kobo) => Number(kobo) / 100;

// ── Recompute one installment's status from the payments recorded against it ──
// Single source of truth for "is this installment settled", shared by the
// webhook and by manually recorded bank transfers. Partial payments are common
// (a buyer sends ₦400k of a ₦500k due), so an installment only flips to paid
// once the payments actually cover the amount due.
async function applyPaymentsToSchedule(scheduleId) {
  const { data: schedule, error: schedErr } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, amount_due, status, due_date')
    .eq('id', scheduleId)
    .single();
  if (schedErr || !schedule) throw new Error('Installment not found');

  const { data: payments, error: payErr } = await supabaseAdmin
    .from('re_payments')
    .select('amount')
    .eq('schedule_id', scheduleId)
    .is('voided_at', null);
  if (payErr) throw payErr;

  const totalPaid = (payments || []).reduce((sum, p) => sum + Number(p.amount), 0);
  const covered = toKobo(totalPaid) >= toKobo(schedule.amount_due);

  // Compare in kobo: 0.1 + 0.2 >= 0.3 is false in floating point.
  if (covered && schedule.status !== 'paid') {
    await supabaseAdmin
      .from('re_installment_schedule')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', scheduleId);
  } else if (!covered && schedule.status === 'paid') {
    // Only reachable by voiding the payment(s) that made this row paid — a
    // payment is never otherwise removed once recorded. Reverts to whatever
    // this row would read as had it never been paid in the first place.
    await supabaseAdmin
      .from('re_installment_schedule')
      .update({ status: isPastDue(schedule.due_date) ? 'overdue' : 'pending', paid_at: null })
      .eq('id', scheduleId);
  }

  return { totalPaid, amountDue: Number(schedule.amount_due), fullyPaid: covered };
}

// ── Payment link for one installment ──────────────────────────────────────
// `callbackUrl` is where Paystack sends the payer once they are done. It
// matters most for the buyer portal: without it Paystack uses the account-wide
// default, and a buyer who has just paid lands on some generic page with no
// route back to their own schedule.
async function initInstallmentPayment(orgId, scheduleId, customerEmail, { callbackUrl = null } = {}) {
  // This workspace's own key if it has configured one, otherwise the
  // platform's — see resolvePaystackSecretKey above.
  const secretKey = await resolvePaystackSecretKey(orgId);
  if (!secretKey) {
    throw Object.assign(new Error('Paystack is not configured.'), { statusCode: 503 });
  }

  const { data: schedule, error } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, amount_due, status')
    .eq('id', scheduleId)
    .eq('organization_id', orgId)
    .single();
  if (error || !schedule) {
    throw Object.assign(new Error('Installment not found'), { statusCode: 404 });
  }
  if (schedule.status === 'paid') {
    throw Object.assign(new Error('Installment already paid'), { statusCode: 409 });
  }

  // Charge only what is still outstanding, so a buyer who part-paid by
  // transfer isn't asked for the full installment again.
  const { data: payments } = await supabaseAdmin
    .from('re_payments')
    .select('amount')
    .eq('schedule_id', scheduleId)
    .is('voided_at', null);
  const alreadyPaid = (payments || []).reduce((sum, p) => sum + Number(p.amount), 0);
  const outstandingKobo = toKobo(schedule.amount_due) - toKobo(alreadyPaid);
  if (outstandingKobo <= 0) {
    throw Object.assign(new Error('Installment already fully covered'), { statusCode: 409 });
  }

  const reference = buildReference(scheduleId);
  let response;
  try {
    response = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: customerEmail,
        amount: outstandingKobo,
        reference,
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
        metadata: { product: 'realestate', schedule_id: scheduleId, organization_id: orgId },
      }),
      // Paystack hanging rather than erroring would otherwise hang this
      // request indefinitely — the buyer's or staff member's "Pay" click
      // spinning forever with no failure ever surfaced.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw Object.assign(
      new Error('Paystack is not responding right now. Try again shortly.'),
      { statusCode: 503 }
    );
  }

  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.status) {
    throw new Error(json.message || 'Paystack initialization failed');
  }

  return {
    authorization_url: json.data.authorization_url,
    reference,
    amount: toNaira(outstandingKobo),
  };
}

// ── Called from a verified Paystack webhook ────────────────────────────────
// Returns false when the reference is not ours, the signal for any co-hosted
// product to carry on handling the event.
//
// PRECONDITION: the caller has already verified the x-paystack-signature HMAC
// against the raw request body. This function trusts the event it is given.
async function handleRealEstateCharge(event) {
  const reference = event?.data?.reference;
  if (!isRealEstateReference(reference)) return false;

  const parsed = parseInstallmentReference(reference);
  if (!parsed) {
    console.error('[re-paystack] REINST reference did not parse, ignoring:', reference);
    return true; // ours by namespace — don't let billing logic touch it
  }

  // Idempotency: Paystack retries until it gets a 200, so the same
  // charge.success arrives more than once. A unique partial index on
  // paystack_reference backs this check up against concurrent deliveries —
  // this lookup is only a fast path to skip the extra work below, so a
  // genuine query failure here (as opposed to "no row found", which is not
  // an error) is logged and swallowed rather than thrown: the insert's own
  // 23505 handling still catches a real duplicate either way.
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('re_payments')
    .select('id')
    .eq('paystack_reference', reference)
    .maybeSingle();
  if (existingErr) console.warn('[re-paystack] duplicate-reference lookup failed, relying on the unique index instead:', existingErr.message);
  if (existing) return true;

  // Read the org from the schedule row rather than from webhook metadata:
  // metadata is caller-supplied and absent on transactions replayed from the
  // Paystack dashboard, and organization_id is NOT NULL.
  const { data: schedule } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, organization_id, amount_due')
    .eq('id', parsed.scheduleId)
    .maybeSingle();
  if (!schedule) {
    console.error('[re-paystack] no installment for reference', reference);
    return true;
  }

  // Paystack normally only ever collects exactly the outstanding amount
  // (initInstallmentPayment charges nothing else) — but a replayed or
  // manually-edited dashboard transaction can still settle for more than is
  // due. Computed the same way the manual path already does, so an
  // overpaid card payment is exactly as visible as an overpaid bank
  // transfer, not silently unaccounted for.
  const amountNaira = toNaira(event.data.amount);
  const { data: priorPayments } = await supabaseAdmin
    .from('re_payments').select('amount').eq('schedule_id', schedule.id).is('voided_at', null);
  const priorKobo = (priorPayments || []).reduce((sum, p) => sum + toKobo(p.amount), 0);
  const excessKobo = priorKobo + toKobo(amountNaira) - toKobo(schedule.amount_due);
  const overpayment = excessKobo > 0 ? toNaira(excessKobo) : 0;

  const { error: insertErr } = await supabaseAdmin.from('re_payments').insert({
    organization_id: schedule.organization_id,
    schedule_id: schedule.id,
    amount: amountNaira,
    paystack_reference: reference,
    method: 'paystack',
    paid_at: event.data.paid_at || new Date().toISOString(),
    overpayment,
  });

  // 23505 = unique violation: a concurrent delivery won the race and already
  // recorded this exact reference. That is success, not failure.
  if (insertErr && insertErr.code !== '23505') throw insertErr;

  await applyPaymentsToSchedule(schedule.id);
  return true;
}

// ── Manual payment (bank transfer dominates Nigerian off-plan sales) ───────
//
// OVERPAYMENT is not rejected, and that is deliberate: a buyer really does send
// ₦5m against a ₦500k installment, either to get ahead or because they
// misread the schedule. Refusing the record would leave money in the bank
// account with nothing in the system to account for it, which is worse than
// recording it.
//
// What it must not do is pass silently. An unexplained credit is a dispute
// trigger in Nigerian property sales — the buyer expects the excess carried
// forward and will say so months later. So the excess is computed, returned,
// and written to the audit trail, and the UI warns before the record is made.
async function recordManualPayment(orgId, scheduleId, {
  amount,
  method = 'bank_transfer',
  reference = null,
  payerName = null,
}) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw Object.assign(new Error('amount must be a positive number'), { statusCode: 400 });
  }

  const { data: schedule, error } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, amount_due, plan_id')
    .eq('id', scheduleId)
    .eq('organization_id', orgId)
    .single();
  if (error || !schedule) {
    throw Object.assign(new Error('Installment not found'), { statusCode: 404 });
  }

  // What was already on this installment before today's money.
  const { data: priorPayments } = await supabaseAdmin
    .from('re_payments').select('amount').eq('schedule_id', scheduleId).is('voided_at', null);
  const priorKobo = (priorPayments || []).reduce((sum, p) => sum + toKobo(p.amount), 0);

  // Computed BEFORE the insert, and written onto the row itself — not just
  // returned to the caller. Commission accrual reads this to cap its base at
  // what was actually due rather than the full transferred amount, and the
  // buyer's record reads it to surface unresolved credit to whoever opens it
  // next, on any device — not just the one that recorded the payment.
  const excessKobo = priorKobo + toKobo(numericAmount) - toKobo(schedule.amount_due);
  const overpayment = excessKobo > 0 ? toNaira(excessKobo) : 0;

  // Two staff members recording the SAME real transfer independently — one
  // off a WhatsApp confirmation, one off the bank statement — is a plausible
  // everyday duplicate, and unlike a Paystack reference there is nothing to
  // reject it outright on: reference is free-text and optional for a manual
  // payment. A warning, not a block — a buyer really can pay the same
  // installment amount twice in one day.
  const { data: recentSame } = await supabaseAdmin
    .from('re_payments')
    .select('id')
    .eq('schedule_id', scheduleId)
    .eq('amount', numericAmount)
    .is('voided_at', null)
    .gte('paid_at', new Date(Date.now() - 24 * 3600_000).toISOString())
    .limit(1);
  const possibleDuplicate = Boolean(recentSame?.length);

  const { data: payment, error: payErr } = await supabaseAdmin
    .from('re_payments')
    .insert({
      organization_id: orgId,
      schedule_id: scheduleId,
      amount: numericAmount,
      method,
      paystack_reference: reference,
      overpayment,
      payer_name: String(payerName || '').trim() || null,
    })
    .select()
    .single();
  if (payErr) throw payErr;

  const result = await applyPaymentsToSchedule(scheduleId);

  return {
    ...payment,
    installment_fully_paid: result.fullyPaid,
    total_paid: result.totalPaid,
    amount_due: Number(schedule.amount_due),
    possible_duplicate: possibleDuplicate,
  };
}

// ── Moving an existing credit onto a different installment ─────────────────
//
// "Allocate the credit" used to call recordManualPayment a second time, which
// inserted a brand-new, independent payment row for money that was never a
// second transfer — double commission, a second receipt, and a buyer total
// inflated by the reallocated amount. This instead marks the new row as
// MOVED credit (reallocated_from_payment_id), which commissionService reads
// to skip accrual a second time, and which every "total paid across the
// plan" sum excludes, since that money was already counted once.
async function reallocateOverpayment(orgId, sourcePaymentId, toScheduleId) {
  const { data: source, error: sourceErr } = await supabaseAdmin
    .from('re_payments')
    .select('id, amount, overpayment, method, paystack_reference, voided_at')
    .eq('id', sourcePaymentId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (sourceErr) throw sourceErr;
  if (!source) throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
  if (source.voided_at) {
    throw Object.assign(new Error('This payment was voided — it has no credit to allocate.'), { statusCode: 409 });
  }

  const creditKobo = toKobo(source.overpayment);
  if (creditKobo <= 0) {
    throw Object.assign(new Error('This payment has no unallocated credit.'), { statusCode: 409 });
  }

  const { data: schedule, error: schedErr } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, amount_due')
    .eq('id', toScheduleId)
    .eq('organization_id', orgId)
    .single();
  if (schedErr || !schedule) {
    throw Object.assign(new Error('Installment not found'), { statusCode: 404 });
  }

  const { data: priorPayments } = await supabaseAdmin
    .from('re_payments').select('amount').eq('schedule_id', toScheduleId).is('voided_at', null);
  const priorKobo = (priorPayments || []).reduce((sum, p) => sum + toKobo(p.amount), 0);
  const creditAmount = toNaira(creditKobo);
  const excessKobo = priorKobo + creditKobo - toKobo(schedule.amount_due);
  const overpayment = excessKobo > 0 ? toNaira(excessKobo) : 0;

  const { data: payment, error: payErr } = await supabaseAdmin
    .from('re_payments')
    .insert({
      organization_id: orgId,
      schedule_id: toScheduleId,
      amount: creditAmount,
      method: source.method,
      paystack_reference: source.paystack_reference,
      overpayment,
      reallocated_from_payment_id: source.id,
    })
    .select()
    .single();
  // The unique index on reallocated_from_payment_id is what actually stops
  // the same credit being spent twice under concurrency — the overpayment
  // check above is the fast, common-case rejection; this is the guarantee.
  if (payErr?.code === '23505') {
    throw Object.assign(new Error('This credit has already been allocated.'), { statusCode: 409 });
  }
  if (payErr) throw payErr;

  const result = await applyPaymentsToSchedule(toScheduleId);

  return {
    ...payment,
    installment_fully_paid: result.fullyPaid,
    total_paid: result.totalPaid,
    amount_due: Number(schedule.amount_due),
  };
}

// ── Voiding a wrongly recorded payment ──────────────────────────────────────
//
// Not a delete — recycle.js's own rule holds here too: "a recorded payment
// is a financial fact... the correction is another entry, not the
// disappearance of the first one." The row stays exactly as entered,
// forever; voided_at/void_reason mark it as no longer counting toward
// anything. The installment it applied to is recomputed here (it may drop
// back to pending or overdue); the caller is responsible for voiding the
// linked commission, if any — see routes/payments.js's /void route, which
// does both inside the same request.
async function voidPayment(orgId, paymentId, reason) {
  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) {
    throw Object.assign(new Error('A reason is required.'), { statusCode: 400 });
  }

  const { data: payment, error } = await supabaseAdmin
    .from('re_payments')
    .select('id, schedule_id, voided_at')
    .eq('id', paymentId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw error;
  if (!payment) throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
  if (payment.voided_at) {
    throw Object.assign(new Error('This payment is already voided.'), { statusCode: 409 });
  }

  // A payment whose overpayment has already been moved onto another
  // installment has to be unwound in that order — voiding this one first
  // would leave the reallocated row pointing at money that turned out never
  // to have existed.
  const { data: reallocation } = await supabaseAdmin
    .from('re_payments')
    .select('id')
    .eq('reallocated_from_payment_id', paymentId)
    .is('voided_at', null)
    .maybeSingle();
  if (reallocation) {
    throw Object.assign(
      new Error("This payment's credit has already been allocated to another installment — void that allocation first."),
      { statusCode: 409 }
    );
  }

  const { data: voided, error: voidErr } = await supabaseAdmin
    .from('re_payments')
    .update({ voided_at: new Date().toISOString(), void_reason: trimmedReason })
    .eq('id', paymentId)
    .eq('organization_id', orgId)
    .select()
    .single();
  if (voidErr) throw voidErr;

  const result = await applyPaymentsToSchedule(payment.schedule_id);

  return { ...voided, installment_still_paid: result.fullyPaid, total_paid: result.totalPaid };
}

module.exports = {
  initInstallmentPayment,
  handleRealEstateCharge,
  recordManualPayment,
  reallocateOverpayment,
  voidPayment,
  applyPaymentsToSchedule,
  parseInstallmentReference,
  isRealEstateReference,
  buildReference,
  resolvePaystackSecretKey,
  verifyWebhookSignature,
  verifyPaystackKey,
};
