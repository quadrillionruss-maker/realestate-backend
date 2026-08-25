// vatService.js — SECTION 9 (feature expansion): VAT disclosure on
// payments, receipts and reports.
//
// SCOPE, STATED PLAINLY: this computes and DISPLAYS a VAT breakdown of an
// already-fixed payment amount. It does NOT change installment_schedule
// totals or the amount a buyer is actually charged in either mode — doing
// that correctly would mean VAT feeding into how a plan's schedule is
// built in the first place (installmentService.buildSchedule), which nets
// out to a pricing-engine change, not a VAT feature, and is out of scope
// here. In "exclusive" mode below, the receipt's own "total incl. VAT"
// line is informational — it does not imply more money was collected than
// payment.amount actually recorded.
//
//   vat_inclusive = true   the recorded amount ALREADY contains VAT.
//                          Disclosed by backing it out:
//                          subtotal = amount / (1 + rate/100)
//   vat_inclusive = false  the recorded amount is treated as the PRE-VAT
//                          figure; VAT is calculated on top for disclosure:
//                          vat = amount * (rate/100)
//
// Computed and snapshotted onto the payment ROW at the moment it is
// recorded (paystackService.js's two insert sites), not read live from
// settings every time a receipt is rendered — see migrations/058's own
// header for why, the same reasoning re_reservations.commission_rate
// already established.
const { supabaseAdmin } = require('../middleware/orgContext');

const DEFAULT_VAT_RATE = 7.5; // Nigeria standard rate, per the product spec

const round2 = (value) => Math.round(Number(value) * 100) / 100;

async function getVatSettings(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_org_settings')
    .select('vat_enabled, vat_rate, vat_inclusive')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw error;
  return {
    enabled: Boolean(data?.vat_enabled),
    rate: data?.vat_rate != null ? Number(data.vat_rate) : DEFAULT_VAT_RATE,
    inclusive: Boolean(data?.vat_inclusive),
  };
}

async function updateVatSettings(orgId, { enabled, rate, inclusive }) {
  const updates = {};
  if (enabled !== undefined) updates.vat_enabled = Boolean(enabled);
  if (inclusive !== undefined) updates.vat_inclusive = Boolean(inclusive);
  if (rate !== undefined) {
    const numericRate = Number(rate);
    if (!Number.isFinite(numericRate) || numericRate < 0 || numericRate > 100) {
      throw Object.assign(new Error('VAT rate must be a number between 0 and 100.'), { statusCode: 400 });
    }
    updates.vat_rate = numericRate;
  }
  if (!Object.keys(updates).length) {
    throw Object.assign(new Error('Nothing to update — provide enabled, rate and/or inclusive.'), { statusCode: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('re_org_settings')
    .upsert({ organization_id: orgId, ...updates }, { onConflict: 'organization_id' })
    .select('vat_enabled, vat_rate, vat_inclusive')
    .single();
  if (error) throw error;
  return { enabled: data.vat_enabled, rate: Number(data.vat_rate), inclusive: data.vat_inclusive };
}

// Pure — the actual math, unit-testable without a database. `settings` is
// exactly what getVatSettings returns above.
function computeVatBreakdown(amount, settings) {
  const numericAmount = round2(amount);
  if (!settings?.enabled) {
    return { applied: false, vat_rate: null, vat_amount: null, vat_inclusive: null, subtotal: numericAmount, total: numericAmount };
  }

  const rate = Number(settings.rate) || 0;
  if (settings.inclusive) {
    const subtotal = round2(numericAmount / (1 + rate / 100));
    const vatAmount = round2(numericAmount - subtotal);
    return { applied: true, vat_rate: rate, vat_amount: vatAmount, vat_inclusive: true, subtotal, total: numericAmount };
  }

  const vatAmount = round2(numericAmount * (rate / 100));
  return {
    applied: true, vat_rate: rate, vat_amount: vatAmount, vat_inclusive: false,
    subtotal: numericAmount, total: round2(numericAmount + vatAmount),
  };
}

// Called from both places a payment is inserted (paystackService.js) —
// never throws, so a VAT lookup failure must not block a real payment from
// being recorded. Falls back to "no VAT" rather than guessing.
async function applyVatToPayment(orgId, amount) {
  try {
    const settings = await getVatSettings(orgId);
    return computeVatBreakdown(amount, settings);
  } catch (err) {
    console.warn('[vat] could not resolve VAT settings, recording without VAT:', err.message);
    return computeVatBreakdown(amount, { enabled: false });
  }
}

module.exports = {
  DEFAULT_VAT_RATE, getVatSettings, updateVatSettings, computeVatBreakdown, applyVatToPayment,
};
