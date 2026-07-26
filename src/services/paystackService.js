// paystackService.js — the only file in this module that knows Paystack exists.
//
// FlowDesk already owns the Paystack account, the initialize call and the
// constant-time HMAC webhook verification. This module does NOT add a second
// webhook endpoint. Instead every real estate transaction reference is
// namespaced `REINST-<schedule uuid>-<timestamp>`, and FlowDesk's existing
// verified webhook calls handleRealEstateCharge(), which returns false for
// anything that isn't ours so subscription-billing logic proceeds untouched.

const { supabaseAdmin } = require('../middleware/orgContext');

const PAYSTACK_BASE = 'https://api.paystack.co';
const REFERENCE_PREFIX = 'REINST-';

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
    .select('id, amount_due, status')
    .eq('id', scheduleId)
    .single();
  if (schedErr || !schedule) throw new Error('Installment not found');

  const { data: payments, error: payErr } = await supabaseAdmin
    .from('re_payments')
    .select('amount')
    .eq('schedule_id', scheduleId);
  if (payErr) throw payErr;

  const totalPaid = (payments || []).reduce((sum, p) => sum + Number(p.amount), 0);
  const covered = toKobo(totalPaid) >= toKobo(schedule.amount_due);

  // Compare in kobo: 0.1 + 0.2 >= 0.3 is false in floating point.
  if (covered && schedule.status !== 'paid') {
    await supabaseAdmin
      .from('re_installment_schedule')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', scheduleId);
  }

  return { totalPaid, amountDue: Number(schedule.amount_due), fullyPaid: covered };
}

// ── Payment link for one installment ──────────────────────────────────────
async function initInstallmentPayment(orgId, scheduleId, customerEmail) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
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
    .eq('schedule_id', scheduleId);
  const alreadyPaid = (payments || []).reduce((sum, p) => sum + Number(p.amount), 0);
  const outstandingKobo = toKobo(schedule.amount_due) - toKobo(alreadyPaid);
  if (outstandingKobo <= 0) {
    throw Object.assign(new Error('Installment already fully covered'), { statusCode: 409 });
  }

  const reference = buildReference(scheduleId);
  const response = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: customerEmail,
      amount: outstandingKobo,
      reference,
      metadata: { product: 'realestate', schedule_id: scheduleId, organization_id: orgId },
    }),
  });

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

// ── Called from FlowDesk's EXISTING verified webhook ───────────────────────
// Returns false when the reference is not a real estate one, which is the
// signal for FlowDesk's subscription logic to carry on handling the event.
// Signature verification has already happened upstream.
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
  // paystack_reference backs this check up against concurrent deliveries.
  const { data: existing } = await supabaseAdmin
    .from('re_payments')
    .select('id')
    .eq('paystack_reference', reference)
    .maybeSingle();
  if (existing) return true;

  // Read the org from the schedule row rather than from webhook metadata:
  // metadata is caller-supplied and absent on transactions replayed from the
  // Paystack dashboard, and organization_id is NOT NULL.
  const { data: schedule } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, organization_id')
    .eq('id', parsed.scheduleId)
    .maybeSingle();
  if (!schedule) {
    console.error('[re-paystack] no installment for reference', reference);
    return true;
  }

  const { error: insertErr } = await supabaseAdmin.from('re_payments').insert({
    organization_id: schedule.organization_id,
    schedule_id: schedule.id,
    amount: toNaira(event.data.amount),
    paystack_reference: reference,
    method: 'paystack',
    paid_at: event.data.paid_at || new Date().toISOString(),
  });

  // 23505 = unique violation: a concurrent delivery won the race and already
  // recorded this exact reference. That is success, not failure.
  if (insertErr && insertErr.code !== '23505') throw insertErr;

  await applyPaymentsToSchedule(schedule.id);
  return true;
}

// ── Manual payment (bank transfer dominates Nigerian off-plan sales) ───────
async function recordManualPayment(orgId, scheduleId, { amount, method = 'bank_transfer', reference = null }) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw Object.assign(new Error('amount must be a positive number'), { statusCode: 400 });
  }

  const { data: schedule, error } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, amount_due')
    .eq('id', scheduleId)
    .eq('organization_id', orgId)
    .single();
  if (error || !schedule) {
    throw Object.assign(new Error('Installment not found'), { statusCode: 404 });
  }

  const { data: payment, error: payErr } = await supabaseAdmin
    .from('re_payments')
    .insert({
      organization_id: orgId,
      schedule_id: scheduleId,
      amount: numericAmount,
      method,
      paystack_reference: reference,
    })
    .select()
    .single();
  if (payErr) throw payErr;

  const result = await applyPaymentsToSchedule(scheduleId);
  return { ...payment, installment_fully_paid: result.fullyPaid, total_paid: result.totalPaid };
}

module.exports = {
  initInstallmentPayment,
  handleRealEstateCharge,
  recordManualPayment,
  applyPaymentsToSchedule,
  parseInstallmentReference,
  isRealEstateReference,
  buildReference,
};
