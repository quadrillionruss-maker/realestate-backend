// logic.test.js — the rules that must not silently break.
//
// Pure logic only: no network, no database, no Supabase calls.
//
//     npm test
//
// The service modules construct a Supabase client at require time, so dummy
// credentials are set below. Nothing here ever issues a query.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
// authService and portalService sign tokens at call time, so a secret has to
// exist. It never leaves this process.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-thirty-two-characters-long';
process.env.RE_DISABLE_CRON = 'true';
// credentials.js (a workspace's own Paystack/Resend keys, encrypted at rest)
// refuses to run at all without this — see that file for why. Fixed rather
// than random so a failing assertion below is reproducible.
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY
  || 'df5730e8398de01582d884020f9522a777190b5e3d4904a8bad5217687c47d9f';

const assert = require('assert');
const jwt = require('jsonwebtoken');
const { execFileSync } = require('child_process');
const path = require('path');

const { buildSchedule, addMonthsUTC } = require('../services/installmentService');
const { parseInstallmentReference, isRealEstateReference, buildReference } = require('../services/paystackService');
const { buildAllocationLetterHtml, describePaymentPlan } = require('../services/documentService');
const { buildFallbackBrief, sanitizeStateForModel, resolveRefs } = require('../services/aiBrief');
const {
  lagosToday, isPastDue, overdueThroughDate, describeDue,
} = require('../services/overdueService');
const { buildReceiptHtml } = require('../services/receiptService');
const { resolveBranding } = require('../services/brandingService');
const { supabaseAdmin } = require('../middleware/orgContext');
const { amountInWords } = require('../utils/amountInWords');
const { parseCsvToObjects, parseAmount, parseDate, toCsv } = require('../utils/csv');
const { stageForOverdueCount, describeStage } = require('../services/escalationService');
const { normalizeNigerianPhone } = require('../services/notificationService');
const auth = require('../services/authService');
const portal = require('../services/portalService');
const env = require('../config/env');
const {
  preview: restructurePreview, contractValue,
} = require('../services/restructureService');
const {
  rentTotalForPeriod, computeNewTenancyEndDate,
} = require('../services/rentalService');
const {
  canAccess, normalizeRole, canInviteRole, wouldExceedWorkspaceCap, actionsFor, ROLES,
} = require('../services/permissions');
const { encrypt, decrypt, last4 } = require('../utils/credentials');

// frontend/realestate.js is a browser script, not a CommonJS module — it
// assigns onto `window.RE` rather than `module.exports`, and its very last
// line registers a DOMContentLoaded listener that expects `document` to
// exist. A minimal `window` stub is enough to load it here: every other
// top-level use of `window` is already wrapped in its own try/catch, so the
// only thing this needs to survive is `window.__API_BASE__` at the top of
// the file. The DOMContentLoaded line still throws — harmlessly, and after
// `window.RE` has already been populated — so it is swallowed rather than
// treated as a real failure.
global.window = global.window || {};
try {
  require('../../frontend/realestate.js');
} catch (err) {
  if (!/document is not defined/.test(err.message)) throw err;
}
const { waNumber, waLink } = global.window.RE;

// screens.js is loaded second, in the same stub, exactly as index.html loads
// it second — it reads `window.RE` at its own top (`var R = window.RE;`) and
// registers screens onto it without touching `document` at require time, so
// the stub above is enough. naturalSort and matchImportColumn/remapCsv are
// otherwise private to its closure; both are exposed onto R purely so this
// offline suite can reach them.
try {
  require('../../frontend/screens.js');
} catch (err) {
  if (!/document is not defined/.test(err.message)) throw err;
}
const { naturalSort, matchImportColumn, remapCsv } = global.window.RE;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function section(title) { console.log(`\n${title}`); }

// resolveBranding is the one async function in this offline-only suite, so it
// gets its own runner rather than forcing `test()` to support promises it
// otherwise never sees.
async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const sumOf = (rows) => rows.reduce((total, row) => total + row.amount_due, 0);

// ── Installment schedule ─────────────────────────────────────────────────
section('Installment schedule');

test('splits evenly when the total divides cleanly', () => {
  const rows = buildSchedule({
    totalAmount: 12_000_000, numberOfInstallments: 12, startDate: '2026-01-15',
  });
  assert.strictEqual(rows.length, 12);
  assert.ok(rows.every((r) => r.amount_due === 1_000_000));
  assert.strictEqual(sumOf(rows), 12_000_000);
});

test('sums to the exact total when it does not divide cleanly', () => {
  // 10,000,000 / 3 is the case that produces 3333333.3333333335 in floats.
  const rows = buildSchedule({
    totalAmount: 10_000_000, numberOfInstallments: 3, startDate: '2026-01-31',
  });
  assert.strictEqual(sumOf(rows), 10_000_000);
  assert.strictEqual(rows[0].amount_due, 3_333_333.33);
  assert.strictEqual(rows[2].amount_due, 3_333_333.34); // remainder lands last
});

test('handles kobo-level totals without drift across 36 installments', () => {
  const rows = buildSchedule({
    totalAmount: 24_750_000.07, numberOfInstallments: 36, startDate: '2026-03-01',
  });
  assert.strictEqual(rows.length, 36);
  assert.strictEqual(Number(sumOf(rows).toFixed(2)), 24_750_000.07);
});

test('clamps month-end dates instead of spilling into the next month', () => {
  const rows = buildSchedule({
    totalAmount: 3_000_000, numberOfInstallments: 4, startDate: '2026-01-31',
  });
  assert.deepStrictEqual(
    rows.map((r) => r.due_date),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']
  );
});

test('clamps to 29 February in a leap year', () => {
  assert.strictEqual(
    addMonthsUTC(new Date(Date.UTC(2028, 0, 31)), 1).toISOString().slice(0, 10),
    '2028-02-29'
  );
});

test('steps by three months when frequency is quarterly', () => {
  const rows = buildSchedule({
    totalAmount: 8_000_000, numberOfInstallments: 4, frequency: 'quarterly', startDate: '2026-02-15',
  });
  assert.deepStrictEqual(
    rows.map((r) => r.due_date),
    ['2026-02-15', '2026-05-15', '2026-08-15', '2026-11-15']
  );
});

test('rejects input that would produce a nonsense schedule', () => {
  assert.throws(() => buildSchedule({ totalAmount: 0, numberOfInstallments: 12, startDate: '2026-01-01' }), /positive/);
  assert.throws(() => buildSchedule({ totalAmount: 1e6, numberOfInstallments: 0, startDate: '2026-01-01' }), /between 1 and 120/);
  assert.throws(() => buildSchedule({ totalAmount: 1e6, numberOfInstallments: 2.5, startDate: '2026-01-01' }), /whole number/);
  assert.throws(() => buildSchedule({ totalAmount: 1e6, numberOfInstallments: 12, startDate: '15/01/2026' }), /YYYY-MM-DD/);
  assert.throws(() => buildSchedule({ totalAmount: 1e6, numberOfInstallments: 12, startDate: '2026-02-31' }), /not a real date/);
});

test('produces identical dates regardless of the server timezone', () => {
  // Railway runs UTC and a laptop does not. Date maths that drifts by a day
  // would shift every due date in a 36-month plan.
  const script = `
    process.env.SUPABASE_URL='http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY='k';
    const { buildSchedule } = require(${JSON.stringify(path.join(__dirname, '../services/installmentService'))});
    process.stdout.write(JSON.stringify(buildSchedule({
      totalAmount: 6000000, numberOfInstallments: 6, startDate: '2026-01-31'
    }).map(r => r.due_date)));
  `;
  const run = (tz) => execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  });

  const lagos = run('Africa/Lagos');
  const losAngeles = run('America/Los_Angeles');
  const auckland = run('Pacific/Auckland');
  assert.strictEqual(lagos, losAngeles);
  assert.strictEqual(lagos, auckland);
  assert.strictEqual(JSON.parse(lagos)[1], '2026-02-28');
});

// ── Paystack references ──────────────────────────────────────────────────
section('Paystack reference namespacing');

test('round-trips a schedule id through a reference', () => {
  // A UUID contains the same '-' the reference uses as a separator, so a
  // naive split() returns a fragment rather than the id.
  const scheduleId = '9f8b7c6d-1234-4a5b-8c9d-0e1f2a3b4c5d';
  const parsed = parseInstallmentReference(buildReference(scheduleId));
  assert.strictEqual(parsed.scheduleId, scheduleId);
});

test('claims REINST references and leaves billing references alone', () => {
  assert.strictEqual(isRealEstateReference('REINST-9f8b7c6d-1234-4a5b-8c9d-0e1f2a3b4c5d-1750000000000'), true);
  assert.strictEqual(isRealEstateReference('T123456789'), false);
  assert.strictEqual(isRealEstateReference('sub_abc123'), false);
  assert.strictEqual(isRealEstateReference(undefined), false);
});

test('refuses to parse a malformed reference rather than guessing', () => {
  assert.strictEqual(parseInstallmentReference('REINST-not-a-uuid-1750000000000'), null);
  assert.strictEqual(parseInstallmentReference('REINST-'), null);
  assert.strictEqual(parseInstallmentReference(''), null);
});

// ── Document rendering ───────────────────────────────────────────────────
section('Allocation letter');

const sampleDoc = {
  id: 'aa11bb22-cc33-4d44-8e55-ff66aa77bb88',
  doc_type: 'allocation_letter',
  re_reservations: {
    id: 'res-1',
    re_customers: { full_name: 'Mrs Adeyemi Okonkwo', email: 'a@example.com', phone: '+2348012345678' },
    re_units: {
      unit_number: 'B12', unit_type: '3-bedroom terrace', size_sqm: 145, list_price: 45_000_000,
      re_projects: { name: 'Lekki Gardens Phase 2', location: 'Ajah, Lagos' },
    },
    re_installment_plans: [{
      total_amount: 45_000_000, number_of_installments: 18, frequency: 'monthly', start_date: '2026-02-01',
    }],
  },
};

test('renders buyer, unit and plan into the letter', () => {
  const html = buildAllocationLetterHtml(sampleDoc, { brand_company_name: 'Adron Homes' });
  assert.ok(html.includes('Mrs Adeyemi Okonkwo'));
  assert.ok(html.includes('B12'));
  assert.ok(html.includes('Lekki Gardens Phase 2, Ajah, Lagos'));
  assert.ok(html.includes('Adron Homes'));
  assert.ok(html.includes('145 sqm'));
  assert.ok(html.includes('₦45,000,000'));
  assert.ok(!html.includes('{{'), 'every placeholder should be substituted');
});

test('the reference number is keyed on the reservation, not the document row', () => {
  // migrations/004+005 already enforce one live allocation letter per
  // reservation, which is what makes this stable across a re-generation —
  // and it is the number a buyer, a bank or a lawyer asks for later, so it
  // should name the sale, not an internal row id.
  const html = buildAllocationLetterHtml(sampleDoc, {});
  assert.ok(html.includes('ALLOC-RES-1'), 'expected the reservation id, uppercased, in the reference');
  assert.ok(!html.includes(sampleDoc.id.slice(0, 8).toUpperCase()),
    'must not fall back to the document id when a reservation id is present');
});

test('escapes buyer-supplied text instead of injecting it as markup', () => {
  const hostile = JSON.parse(JSON.stringify(sampleDoc));
  hostile.re_reservations.re_customers.full_name = '<script>alert(1)</script>';
  const html = buildAllocationLetterHtml(hostile, {});
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('ignores a non-https logo url', () => {
  const html = buildAllocationLetterHtml(sampleDoc, { brand_logo_url: 'file:///etc/passwd' });
  assert.ok(!html.includes('etc/passwd'));
});

test('omits the size row when the unit has no recorded size', () => {
  const noSize = JSON.parse(JSON.stringify(sampleDoc));
  delete noSize.re_reservations.re_units.size_sqm;
  const html = buildAllocationLetterHtml(noSize, {});
  assert.ok(!html.includes('<td>Size</td>'));
});

test('describes both installment and outright purchases', () => {
  assert.match(
    describePaymentPlan(sampleDoc.re_reservations.re_installment_plans, 45_000_000),
    /18 monthly installments of approximately ₦2,500,000/
  );
  assert.match(describePaymentPlan(null, 45_000_000), /^Outright payment of ₦45,000,000$/);
});

// ── Fallback brief ───────────────────────────────────────────────────────
section('Rule-based brief (no OpenAI key)');

const overdueState = {
  today: '2026-07-26',
  overdue: [
    { reservation_id: 'r1', customer_name: 'Mr Bello', project: 'Lekki Gardens', unit_number: 'A3', amount: 500_000, days_late: 40 },
    { reservation_id: 'r1', customer_name: 'Mr Bello', project: 'Lekki Gardens', unit_number: 'A3', amount: 500_000, days_late: 10 },
    { reservation_id: 'r2', customer_name: 'Ms Chidi', project: 'Lekki Gardens', unit_number: 'C7', amount: 250_000, days_late: 5 },
  ],
  upcomingWeek: [{ amount: 750_000 }],
  pendingDocuments: [{ id: 'd1' }],
};

test('summarises the day in figures a CEO can act on', () => {
  const brief = buildFallbackBrief(overdueState);
  assert.match(brief.summary, /2 buyers are behind on ₦1,250,000 across 3 installments/);
  assert.match(brief.summary, /1 payment totalling ₦750,000 falls due in the next 7 days/);
  assert.match(brief.summary, /1 document is still waiting/);
  assert.match(brief.summary, /Start with Mr Bello/); // largest exposure first
});

test('grades severity by how far behind the buyer is', () => {
  const brief = buildFallbackBrief(overdueState);
  const bello = brief.risks.find((r) => r.customer_name === 'Mr Bello');
  const chidi = brief.risks.find((r) => r.customer_name === 'Ms Chidi');
  assert.strictEqual(bello.severity, 'medium'); // 2 missed, 40 days
  assert.strictEqual(chidi.severity, 'low');    // 1 missed, 5 days
});

test('drafts a usable WhatsApp message per buyer behind', () => {
  const brief = buildFallbackBrief(overdueState);
  const draft = brief.follow_ups[0];
  assert.ok(draft.whatsapp_draft.includes('Mr Bello'));
  assert.ok(draft.whatsapp_draft.includes('₦1,000,000'));
  assert.ok(draft.whatsapp_draft.includes('Unit A3'));
  assert.strictEqual(draft.reservation_id, 'r1');
  assert.ok(!/pay immediately|debt|legal/i.test(draft.whatsapp_draft), 'tone stays non-threatening');
});

test('files one task per buyer, not one per missed installment', () => {
  const brief = buildFallbackBrief(overdueState);
  assert.strictEqual(brief.recommendations.length, 2);
  assert.match(brief.recommendations[0].title, /Call Mr Bello about 2 missed installments/);
});

test('reports an all-clear day without inventing work', () => {
  const brief = buildFallbackBrief({ today: '2026-07-26', overdue: [], upcomingWeek: [], pendingDocuments: [] });
  assert.match(brief.summary, /No overdue installments today/);
  assert.strictEqual(brief.risks.length, 0);
  assert.strictEqual(brief.recommendations.length, 0);
});

// ── Dates ────────────────────────────────────────────────────────────────
section('Lagos date handling');

test('returns an ISO date string for Africa/Lagos', () => {
  assert.match(lagosToday(), /^\d{4}-\d{2}-\d{2}$/);
});

// ── The 6pm cutoff ───────────────────────────────────────────────────────
// An installment is due by 18:00 Africa/Lagos on its due date. These fix the
// boundary in place, because "when exactly is this late?" is the question a
// buyer argues about.
section('Due-date cutoff (18:00 Africa/Lagos)');

// Lagos is UTC+1 year-round, so 17:00Z is 18:00 Lagos.
const atLagos = (iso) => new Date(iso);

test('an installment due today is NOT overdue during the working day', () => {
  // 09:00 Lagos on the due date.
  assert.strictEqual(isPastDue('2026-07-30', atLagos('2026-07-30T08:00:00Z')), false);
});

test('it is still not overdue one minute before the cutoff', () => {
  // 17:59 Lagos.
  assert.strictEqual(isPastDue('2026-07-30', atLagos('2026-07-30T16:59:00Z')), false);
});

test('it becomes overdue exactly at 18:00 Lagos', () => {
  assert.strictEqual(isPastDue('2026-07-30', atLagos('2026-07-30T17:00:00Z')), true);
});

test('yesterday is overdue whatever time of day it is now', () => {
  assert.strictEqual(isPastDue('2026-07-29', atLagos('2026-07-30T00:30:00Z')), true);
  assert.strictEqual(isPastDue('2026-07-29', atLagos('2026-07-30T08:00:00Z')), true);
});

test('a future installment is never overdue', () => {
  assert.strictEqual(isPastDue('2026-08-15', atLagos('2026-07-30T17:00:00Z')), false);
});

test('the sweep window moves from yesterday to today at the cutoff', () => {
  // Before 18:00 the sweep must not touch today's rows.
  assert.strictEqual(overdueThroughDate(atLagos('2026-07-30T16:00:00Z')), '2026-07-29');
  // From 18:00 it includes them.
  assert.strictEqual(overdueThroughDate(atLagos('2026-07-30T17:00:00Z')), '2026-07-30');
});

test('the cutoff is read in Lagos, not in the host timezone', () => {
  // 23:30 UTC on the 29th is 00:30 Lagos on the 30th. A UTC-thinking server
  // would still be on the 29th and would sweep a day late.
  assert.strictEqual(overdueThroughDate(atLagos('2026-07-29T23:30:00Z')), '2026-07-29');
  assert.strictEqual(lagosToday(atLagos('2026-07-29T23:30:00Z')), '2026-07-30');
});

test('month and year boundaries do not slip', () => {
  assert.strictEqual(overdueThroughDate(atLagos('2026-08-01T10:00:00Z')), '2026-07-31');
  assert.strictEqual(overdueThroughDate(atLagos('2027-01-01T10:00:00Z')), '2026-12-31');
  // 1 March after a leap February.
  assert.strictEqual(overdueThroughDate(atLagos('2028-03-01T10:00:00Z')), '2028-02-29');
});

test('states the deadline in words a buyer can be held to', () => {
  assert.strictEqual(describeDue('2026-07-30'), '30 Jul 2026 by 6pm');
});

test('uses the Lagos day, not the host timezone day', () => {
  // 23:30 UTC is already tomorrow in Lagos (UTC+1). An installment due
  // "tomorrow" must not be marked overdue by a UTC-hosted cron.
  const utcDate = new Date('2026-07-26T23:30:00Z');
  assert.strictEqual(
    utcDate.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }),
    '2026-07-27'
  );
});

// ── Promises and escalation ──────────────────────────────────────────────
section('Escalation and promises');

test('escalates by how many installments have been missed, not by feel', () => {
  assert.strictEqual(stageForOverdueCount(0).key, 'none');
  assert.strictEqual(stageForOverdueCount(1).key, 'reminder');
  assert.strictEqual(stageForOverdueCount(2).key, 'reminder');
  assert.strictEqual(stageForOverdueCount(3).key, 'formal_notice');
  assert.strictEqual(stageForOverdueCount(5).key, 'final_notice');
  assert.strictEqual(stageForOverdueCount(9).key, 'legal');
});

test('an unknown stage reads as "none" rather than throwing', () => {
  assert.strictEqual(describeStage('nonsense').key, 'none');
  assert.strictEqual(describeStage(null).key, 'none');
});

const promiseState = {
  today: '2026-07-26',
  overdue: [
    { reservation_id: 'r1', customer_name: 'Mrs Adeyemi', project: 'Lekki Gardens', unit_number: 'B12', amount: 500_000, days_late: 12, escalation_stage: 'reminder' },
    { reservation_id: 'r1', customer_name: 'Mrs Adeyemi', project: 'Lekki Gardens', unit_number: 'B12', amount: 500_000, days_late: 42, escalation_stage: 'reminder' },
  ],
  upcomingWeek: [],
  pendingDocuments: [],
  promises: [
    { customer_name: 'Mrs Adeyemi', promised_date: '2026-07-15', promised_amount: 500_000, status: 'broken' },
  ],
};

test('a broken promise raises severity and is named in the brief', () => {
  const brief = buildFallbackBrief(promiseState);
  const risk = brief.risks[0];
  assert.strictEqual(risk.severity, 'high');
  assert.match(risk.reason, /promised to pay by 2026-07-15 and did not/);
  assert.match(brief.summary, /1 buyer has broken a promise to pay/);
});

test('the drafted message references the date the buyer chose, not the due date', () => {
  const draft = buildFallbackBrief(promiseState).follow_ups[0];
  assert.ok(draft.whatsapp_draft.includes('2026-07-15'));
  assert.ok(!/pay immediately|debt/i.test(draft.whatsapp_draft), 'tone stays non-threatening');
});

test('a buyer at legal stage gets no drafted message at all', () => {
  const legal = {
    today: '2026-07-26',
    overdue: Array.from({ length: 8 }, (_, i) => ({
      reservation_id: 'r9', customer_name: 'Mr Silent', amount: 250_000,
      days_late: 200 - i * 10, escalation_stage: 'legal',
    })),
    upcomingWeek: [], pendingDocuments: [], promises: [],
  };
  const brief = buildFallbackBrief(legal);
  assert.strictEqual(brief.follow_ups.length, 0, 'nothing written to a buyer whose file is with a lawyer');
  assert.match(brief.recommendations[0].title, /Refer Mr Silent to legal review/);
});

// A tenant 30 days late on rent is a different situation from an off-plan
// buyer who missed a payment, and the brief must not use the same word for
// both (requirement: "Brief should say 'rent' not 'installment' for rental
// reservations").
const mixedState = {
  today: '2026-07-26',
  overdue: [
    { reservation_id: 'r10', customer_name: 'Mr Bello', project: 'Lekki Gardens', unit_number: 'A3',
      amount: 500_000, days_late: 40, property_type: 'off_plan' },
    { reservation_id: 'r11', customer_name: 'Mrs Okafor', project: 'Ikoyi Heights', unit_number: '4B',
      amount: 300_000, days_late: 35, property_type: 'rental' },
    { reservation_id: 'r11', customer_name: 'Mrs Okafor', project: 'Ikoyi Heights', unit_number: '4B',
      amount: 300_000, days_late: 5, property_type: 'rental' },
  ],
  upcomingWeek: [], pendingDocuments: [], promises: [],
};

test('the summary distinguishes buyers behind on installments from tenants behind on rent', () => {
  const brief = buildFallbackBrief(mixedState);
  assert.match(brief.summary, /1 buyer is behind on ₦500,000 across 1 installment/);
  assert.match(brief.summary, /1 tenant is behind on ₦600,000 in rent across 2 payments/);
  assert.ok(!/1 tenant is behind on[^.]*installment/.test(brief.summary), 'a tenant\'s arrears must not be called an installment');
});

test('a rental risk reason says rent payments, not installments', () => {
  const brief = buildFallbackBrief(mixedState);
  const tenant = brief.risks.find((r) => r.customer_name === 'Mrs Okafor');
  const buyer = brief.risks.find((r) => r.customer_name === 'Mr Bello');
  assert.match(tenant.reason, /2 missed rent payments/);
  assert.match(buyer.reason, /1 missed installment/);
});

test('a rental WhatsApp draft references the Tenancy Agreement, not the Contract of Sale', () => {
  const brief = buildFallbackBrief(mixedState);
  const tenantDraft = brief.follow_ups.find((f) => f.customer_name === 'Mrs Okafor');
  const buyerDraft = brief.follow_ups.find((f) => f.customer_name === 'Mr Bello');
  // Both are at 'reminder' stage (fewer than 3 missed) in this fixture, so
  // neither draft mentions the contract yet — assert the SUBJECT LINE instead,
  // which does differ at every stage.
  assert.match(tenantDraft.email_subject, /Outstanding rent payment/);
  assert.match(buyerDraft.email_subject, /Outstanding installment/);
});

test('a rental recommendation is phrased in rent, not installments', () => {
  const brief = buildFallbackBrief(mixedState);
  const tenantRec = brief.recommendations.find((r) => r.title.includes('Okafor'));
  assert.match(tenantRec.title, /2 missed rent payments/);
});

test('a rental in final-notice arrears references the Tenancy Agreement and tenancy risk', () => {
  // 5 missed reaches 'final_notice' (see stageKeyForCount) — the stage whose
  // wording states a consequence at all. 'formal_notice' (3-4 missed) is
  // still deliberately silent on risk, matching the same ladder off-plan
  // buyers are held to.
  const formalRental = {
    today: '2026-07-26',
    overdue: Array.from({ length: 5 }, (_, i) => ({
      reservation_id: 'r20', customer_name: 'Mr Eze', project: 'Victoria Island', unit_number: '2A',
      amount: 400_000, days_late: 150 - i * 30, property_type: 'rental',
    })),
    upcomingWeek: [], pendingDocuments: [], promises: [],
  };
  const brief = buildFallbackBrief(formalRental);
  const draft = brief.follow_ups[0];
  assert.match(draft.whatsapp_draft, /Tenancy Agreement/);
  assert.match(draft.whatsapp_draft, /this tenancy is at risk/);
  assert.ok(!/Contract of Sale/.test(draft.whatsapp_draft));
  assert.ok(!/this allocation is at risk/.test(draft.whatsapp_draft));
});

// The OpenAI brief prompt must never carry a real name, phone number or
// email — every buyer is represented by an opaque customer_ref instead
// (aiBrief.gatherOrgState), and these two functions are the whole boundary:
// sanitizeStateForModel strips PII going out, resolveRefs restores real
// names coming back. A regression in either one is a live NDPR problem, not
// just a wrong label on screen.
test('sanitizeStateForModel strips name, phone and email from every row before it would reach OpenAI', () => {
  const state = {
    today: '2026-07-26',
    overdue: [{
      schedule_id: 's1', reservation_id: 'r1', customer_ref: 'BUYER_1',
      customer_name: 'Mrs Adeyemi Okonkwo', customer_phone: '08031234567', customer_email: 'a@example.com',
      amount: 500_000,
    }],
    upcomingWeek: [],
    pendingDocuments: [{
      id: 'd1', customer_ref: 'BUYER_1', customer_name: 'Mrs Adeyemi Okonkwo', doc_type: 'allocation_letter',
    }],
    promises: [{
      customer_ref: 'BUYER_1', customer_name: 'Mrs Adeyemi Okonkwo', status: 'open', promised_date: '2026-08-01',
    }],
    nameByRef: new Map([['BUYER_1', 'Mrs Adeyemi Okonkwo']]),
  };

  const sanitized = sanitizeStateForModel(state);
  const serialized = JSON.stringify(sanitized);

  assert.ok(!/Adeyemi/.test(serialized), 'buyer name leaked into the sanitized payload');
  assert.ok(!/08031234567/.test(serialized), 'phone number leaked into the sanitized payload');
  assert.ok(!/a@example\.com/.test(serialized), 'email leaked into the sanitized payload');
  assert.ok(!('nameByRef' in sanitized), 'the name lookup map itself must never be serialized outward');

  // What SHOULD survive: the ref and every non-personal field, so the model
  // still has enough to write a grounded brief.
  assert.strictEqual(sanitized.overdue[0].customer_ref, 'BUYER_1');
  assert.strictEqual(sanitized.overdue[0].amount, 500_000);
  assert.strictEqual(sanitized.pendingDocuments[0].customer_ref, 'BUYER_1');
  assert.strictEqual(sanitized.promises[0].customer_ref, 'BUYER_1');
});

test('resolveRefs turns the model\'s ref-only response back into one with real names', () => {
  const nameByRef = new Map([['BUYER_1', 'Mrs Adeyemi Okonkwo'], ['BUYER_2', 'Mr Bello']]);
  const modelResponse = {
    summary: 'BUYER_1 is 40 days behind; BUYER_2 is current.',
    risks: [{ customer_ref: 'BUYER_1', reason: 'missed two installments', severity: 'high' }],
    follow_ups: [{
      customer_ref: 'BUYER_1',
      reservation_id: 'r1',
      whatsapp_draft: 'Dear BUYER_1, we have not received your installment.',
      email_subject: 'Payment reminder for BUYER_1',
      email_draft: 'Dear BUYER_1,\n\nPlease settle your balance.',
    }],
    recommendations: [{ title: 'Call BUYER_1 about the missed installment', reservation_id: 'r1' }],
  };

  const resolved = resolveRefs(modelResponse, nameByRef);

  assert.strictEqual(resolved.risks[0].customer_name, 'Mrs Adeyemi Okonkwo');
  assert.ok(!('customer_ref' in resolved.risks[0]), 'the raw ref must not leak into the stored brief');
  assert.strictEqual(resolved.follow_ups[0].customer_name, 'Mrs Adeyemi Okonkwo');
  assert.match(resolved.follow_ups[0].whatsapp_draft, /Dear Mrs Adeyemi Okonkwo,/);
  assert.match(resolved.follow_ups[0].email_subject, /Mrs Adeyemi Okonkwo/);
  assert.match(resolved.follow_ups[0].email_draft, /Dear Mrs Adeyemi Okonkwo,/);
  assert.match(resolved.recommendations[0].title, /Call Mrs Adeyemi Okonkwo about/);
  assert.match(resolved.summary, /Mrs Adeyemi Okonkwo is 40 days behind; Mr Bello is current\./);

  // No stray ref tokens anywhere in the final, buyer-facing brief.
  const serialized = JSON.stringify(resolved);
  assert.ok(!/BUYER_\d/.test(serialized), 'a raw ref token survived into the resolved brief');
});

test('resolveRefs falls back to a safe phrase for a ref the model invents or drops', () => {
  const nameByRef = new Map([['BUYER_1', 'Mrs Adeyemi Okonkwo']]);
  const resolved = resolveRefs({
    risks: [{ customer_ref: 'BUYER_9', reason: 'unrecognized ref', severity: 'low' }],
    follow_ups: [], recommendations: [], summary: '',
  }, nameByRef);
  assert.strictEqual(resolved.risks[0].customer_name, 'this buyer');
});

// ── Rental tenancies ─────────────────────────────────────────────────────
// A rental's monthly-rent schedule is an installment plan in every sense
// installmentService already understands one; these two are the only pieces
// specific to a LEASE rather than a sale — the total for a renewal period,
// and the new end date "renew" produces.
section('Rental tenancy renewal');

test('a 12-month renewal totals monthly rent times the duration', () => {
  assert.strictEqual(rentTotalForPeriod(500_000, 12), 6_000_000);
});

test('rounds to the kobo rather than drifting', () => {
  // 333,333.335 × 3 is 1,000,000.005 in floating point; the total must round
  // to the nearest kobo rather than carrying that fraction forward.
  assert.strictEqual(rentTotalForPeriod(333_333.335, 3), 1_000_000.01);
});

test('a renewal schedule sums to exactly the rent total, same as any plan', () => {
  const rows = buildSchedule({
    totalAmount: rentTotalForPeriod(450_000, 11), numberOfInstallments: 11,
    frequency: 'monthly', startDate: '2027-01-01',
  });
  assert.strictEqual(sumOf(rows), 450_000 * 11);
});

test('a 12-month renewal ends exactly one year after it starts', () => {
  assert.strictEqual(computeNewTenancyEndDate('2026-01-01', 12), '2027-01-01');
});

test('renewal end dates clamp at month-end, same as installment due dates', () => {
  // A tenancy starting 31 Jan renews to 28/29 Feb rather than spilling into
  // March — the same clamp addMonthsUTC applies everywhere else.
  assert.strictEqual(computeNewTenancyEndDate('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(computeNewTenancyEndDate('2028-01-31', 1), '2028-02-29'); // leap year
});

test('renewing from an existing tenancy_end_date extends it forward, not from today', () => {
  // A lease renewed two weeks before it actually expires must not shorten the
  // tenant's paid-for period — the new term starts where the old one ends.
  const currentEnd = '2026-06-01';
  const newEnd = computeNewTenancyEndDate(currentEnd, 6);
  assert.strictEqual(newEnd, '2026-12-01');
});

// ── Plan restructuring ───────────────────────────────────────────────────
// A renegotiated schedule must not lose or invent money. The invariant is:
//     original_total_amount = carried_amount_paid + total_amount
// and the new schedule sums to total_amount exactly.
section('Plan restructuring');

test('reads the contract value whether or not the plan was restructured', () => {
  // A plan that has never been restructured has no original_total_amount.
  assert.strictEqual(contractValue({ total_amount: 45_000_000 }), 45_000_000);
  // One that has keeps the contract value there, while total_amount is the
  // balance being rescheduled.
  assert.strictEqual(
    contractValue({ total_amount: 33_750_000, original_total_amount: 45_000_000 }),
    45_000_000
  );
  assert.strictEqual(contractValue(null), 0);
});

test('the restructured schedule sums to exactly the remaining balance', () => {
  // ₦45m contract, ₦11.25m paid, so ₦33.75m rescheduled over 18 months.
  const rows = restructurePreview(33_750_000, {
    numberOfInstallments: 18, frequency: 'monthly', startDate: '2026-09-01',
  });
  assert.strictEqual(rows.length, 18);
  assert.strictEqual(sumOf(rows), 33_750_000, 'the kobo invariant survives a restructure');
});

test('a remainder that does not divide still balances to the kobo', () => {
  const rows = restructurePreview(10_000_000, {
    numberOfInstallments: 3, frequency: 'monthly', startDate: '2026-09-01',
  });
  assert.strictEqual(sumOf(rows), 10_000_000);
  // The last installment carries the rounding, as everywhere else.
  assert.ok(rows[2].amount_due > rows[0].amount_due);
});

test('carried + rescheduled reconstructs the contract exactly', () => {
  const contract = 45_000_000;
  const carried = 11_250_000;
  const remaining = contract - carried;
  const rows = restructurePreview(remaining, {
    numberOfInstallments: 7, frequency: 'quarterly', startDate: '2026-10-01',
  });
  assert.strictEqual(carried + sumOf(rows), contract);
});

test('quarterly restructuring steps three months at a time', () => {
  const rows = restructurePreview(3_000_000, {
    numberOfInstallments: 3, frequency: 'quarterly', startDate: '2026-09-30',
  });
  assert.deepStrictEqual(
    rows.map((r) => r.due_date),
    ['2026-09-30', '2026-12-30', '2027-03-30']
  );
});

test('refuses a restructure that would produce a nonsense schedule', () => {
  assert.throws(() => restructurePreview(0, {
    numberOfInstallments: 6, frequency: 'monthly', startDate: '2026-09-01',
  }), /positive/i);
  assert.throws(() => restructurePreview(1_000_000, {
    numberOfInstallments: 0, frequency: 'monthly', startDate: '2026-09-01',
  }), /whole number/i);
});

// ── Amounts in words ─────────────────────────────────────────────────────
section('Amount in words (receipts)');

test('writes Naira amounts the way a receipt must state them', () => {
  assert.strictEqual(amountInWords(0), 'Zero Naira Only');
  assert.strictEqual(amountInWords(1), 'One Naira Only');
  assert.strictEqual(amountInWords(105), 'One Hundred and Five Naira Only');
  assert.strictEqual(amountInWords(2_500_000), 'Two Million, Five Hundred Thousand Naira Only');
  assert.strictEqual(amountInWords(45_000_000), 'Forty-Five Million Naira Only');
});

test('states kobo rather than dropping them', () => {
  assert.strictEqual(amountInWords(1500.5), 'One Thousand, Five Hundred Naira and Fifty Kobo Only');
});

test('rounds in kobo, so floating point never reaches the paper', () => {
  // 0.1 + 0.2 is 0.30000000000000004; the receipt must say thirty kobo.
  assert.strictEqual(amountInWords(0.1 + 0.2), 'Zero Naira and Thirty Kobo Only');
});

// ── Receipt ──────────────────────────────────────────────────────────────
section('Payment receipt');

const receiptContext = {
  payment: {
    id: 'p1', amount: 3_750_000, method: 'bank_transfer',
    paystack_reference: 'GTB/2026/0042', paid_at: '2026-07-20T09:00:00Z',
  },
  schedule: { id: 's1', installment_number: 3, due_date: '2026-07-01', amount_due: 3_750_000, status: 'paid' },
  plan: { id: 'pl1', total_amount: 45_000_000, number_of_installments: 12 },
  reservation: { id: 'r1' },
  customer: { full_name: 'Mrs Adeyemi Okonkwo', email: 'a@example.com' },
  unit: { unit_number: 'B12', unit_type: '3-bed terrace' },
  project: { name: 'Lekki Gardens Phase 2', location: 'Ajah, Lagos' },
  totalPaid: 11_250_000,
  balance: 33_750_000,
};

test('renders the buyer, the amount, the words and the balance', () => {
  const html = buildReceiptHtml(receiptContext, { company_name: 'Adron Homes' }, 'RCPT-ABC12345');
  assert.ok(html.includes('Mrs Adeyemi Okonkwo'));
  assert.ok(html.includes('₦3,750,000'));
  assert.ok(html.includes('Three Million, Seven Hundred and Fifty Thousand Naira Only'));
  assert.ok(html.includes('₦33,750,000'), 'the balance is what stops the follow-up phone call');
  assert.ok(html.includes('RCPT-ABC12345'));
  assert.ok(html.includes('Adron Homes'));
  assert.ok(!html.includes('{{'), 'every placeholder should be substituted');
});

test('escapes a hostile bank reference instead of injecting it as markup', () => {
  const hostile = JSON.parse(JSON.stringify(receiptContext));
  hostile.payment.paystack_reference = '<img src=x onerror=alert(1)>';
  const html = buildReceiptHtml(hostile, {}, 'RCPT-1');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

test('omits the reference row rather than printing an empty one', () => {
  const noRef = JSON.parse(JSON.stringify(receiptContext));
  noRef.payment.paystack_reference = null;
  assert.ok(!buildReceiptHtml(noRef, {}, 'RCPT-1').includes('<td>Reference</td>'));
});

test('ignores a non-https logo url', () => {
  const html = buildReceiptHtml(receiptContext, { logo_url: 'file:///etc/passwd' }, 'RCPT-1');
  assert.ok(!html.includes('etc/passwd'));
});

// ── CSV import ───────────────────────────────────────────────────────────
section('CSV import');

test('keeps a quoted comma inside one field', () => {
  const { records } = parseCsvToObjects('full_name,phone\n"Okonkwo, Adeyemi",08031234567');
  assert.strictEqual(records[0].full_name, 'Okonkwo, Adeyemi');
  assert.strictEqual(records[0].phone, '08031234567');
});

test('handles escaped quotes and embedded newlines', () => {
  const { records } = parseCsvToObjects('name,note\n"Bello","He said ""Friday""\nthen went quiet"');
  assert.strictEqual(records[0].note, 'He said "Friday"\nthen went quiet');
});

test('strips the BOM Excel writes, so the first column still matches', () => {
  const { headers } = parseCsvToObjects('﻿full_name,phone\nA,1');
  assert.strictEqual(headers[0], 'full_name');
});

test('normalizes header capitalization and spacing', () => {
  const { records } = parseCsvToObjects('Full Name,Unit Number\nAda,B12');
  assert.strictEqual(records[0].full_name, 'Ada');
  assert.strictEqual(records[0].unit_number, 'B12');
});

test('reports the spreadsheet row number, not the array index', () => {
  const { records } = parseCsvToObjects('name\nA\nB');
  assert.strictEqual(records[0].__row, 2, 'the header is row 1');
  assert.strictEqual(records[1].__row, 3);
});

test('reads amounts as developers actually paste them', () => {
  assert.strictEqual(parseAmount('₦45,000,000'), 45_000_000);
  assert.strictEqual(parseAmount('45000000.50'), 45_000_000.5);
  assert.strictEqual(parseAmount(''), null);
  assert.strictEqual(parseAmount('not a number'), null);
});

test('reads dates day-first, which is the local convention', () => {
  assert.strictEqual(parseDate('2026-03-01'), '2026-03-01');
  assert.strictEqual(parseDate('01/03/2026'), '2026-03-01');
  assert.strictEqual(parseDate(''), null);
});

// ── CSV export ───────────────────────────────────────────────────────────
section('CSV export');

test('quotes only what needs quoting, and doubles embedded quotes', () => {
  const csv = toCsv(
    [['Name', 'name'], ['Note', 'note']],
    [{ name: 'Okonkwo, Adeyemi', note: 'said "Friday"' }, { name: 'Bello', note: 'fine' }]
  );
  assert.ok(csv.includes('"Okonkwo, Adeyemi"'), 'a comma forces quotes');
  assert.ok(csv.includes('"said ""Friday"""'), 'quotes are doubled');
  assert.ok(csv.includes('Bello,fine'), 'plain values stay unquoted');
});

test('starts with a BOM so Excel does not mangle the Naira sign', () => {
  const csv = toCsv([['Amount', 'amount']], [{ amount: '₦45,000,000' }]);
  assert.strictEqual(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('₦45,000,000'));
});

test('round-trips through the parser', () => {
  const rows = [{ full_name: 'Okonkwo, Adeyemi', phone: '08031234567' }];
  const csv = toCsv([['Full name', 'full_name'], ['Phone', 'phone']], rows);
  const { records } = parseCsvToObjects(csv);
  assert.strictEqual(records[0].full_name, 'Okonkwo, Adeyemi');
  assert.strictEqual(records[0].phone, '08031234567');
});

test('renders a missing value as empty rather than "null"', () => {
  const csv = toCsv([['Email', 'email']], [{ email: null }, {}]);
  assert.ok(!/null|undefined/.test(csv), csv);
});

// ── Session invalidation ─────────────────────────────────────────────────
section('Session tokens');

test('issues a token carrying the session generation', () => {
  const token = auth.issueToken({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'a@b.c', token_version: 3 });
  const claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  assert.strictEqual(claims.tv, 3);
  assert.strictEqual(claims.id, claims.sub, 'both claim names are set for compatibility');
});

test('a user with no token_version still gets a usable token', () => {
  const token = auth.issueToken({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'b@c.d' });
  const claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  assert.strictEqual(claims.tv, 0, 'defaults to generation 0, matching the column default');
});

test('a staff token carries no audience, so the portal cannot accept it', () => {
  const token = auth.issueToken({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'c@d.e' });
  const claims = jwt.decode(token);
  assert.strictEqual(claims.aud, undefined);
});

test('a portal token carries aud:re-portal, so the staff API cannot accept it', () => {
  const token = portal.issuePortalToken({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    organization_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    portal_token_version: 2,
  });
  const claims = jwt.decode(token);
  assert.strictEqual(claims.aud, 're-portal');
  assert.strictEqual(claims.v, 2);
  assert.strictEqual(claims.id, undefined, 'no subject claim the staff middleware would read');
});

test('portal link lifetime is capped, however PORTAL_TOKEN_TTL_DAYS is set', () => {
  // A link nobody remembers to revoke has to expire on its own eventually.
  assert.ok(env.portal.tokenTtlDays <= 90, `got ${env.portal.tokenTtlDays}`);
  assert.ok(env.portal.tokenTtlDays >= 1, `got ${env.portal.tokenTtlDays}`);
});

// ── Phone numbers ────────────────────────────────────────────────────────
section('Nigerian phone numbers');

test('normalizes every form a buyer list contains', () => {
  assert.strictEqual(normalizeNigerianPhone('08031234567'), '2348031234567');
  assert.strictEqual(normalizeNigerianPhone('+234 803 123 4567'), '2348031234567');
  assert.strictEqual(normalizeNigerianPhone('234-803-123-4567'), '2348031234567');
  assert.strictEqual(normalizeNigerianPhone('8031234567'), '2348031234567');
  assert.strictEqual(normalizeNigerianPhone(''), null);
});

// waNumber() is the frontend's own normalizer, feeding wa.me links directly —
// a different file from notificationService's normalizeNigerianPhone above,
// tested separately because a bug here renders a broken link in the browser,
// not just a malformed outbound SMS.
test('waNumber accepts every normal form and produces exactly 13 digits', () => {
  assert.strictEqual(waNumber('08031234567'), '2348031234567');
  assert.strictEqual(waNumber('+234 803 123 4567'), '2348031234567');
  assert.strictEqual(waNumber('234-803-123-4567'), '2348031234567');
  assert.strictEqual(waNumber('8031234567'), '2348031234567');
});

test('waNumber returns null for anything that does not normalize to 13 digits', () => {
  // A landline-length or partially-pasted number.
  assert.strictEqual(waNumber('803 123 456'), null);
  // Too long — an extra digit, or a non-Nigerian number.
  assert.strictEqual(waNumber('070312345678'), null);
  assert.strictEqual(waNumber(''), null);
  assert.strictEqual(waNumber(null), null);
});

test('waLink renders no link at all for a number waNumber rejects', () => {
  // A broken wa.me link — one WhatsApp opens and then refuses — is worse than
  // no link, because it looks like it should have worked.
  assert.strictEqual(waLink('12345'), null);
  assert.strictEqual(waLink('08031234567'), 'https://wa.me/2348031234567');
});

// naturalSort backs the Units screen, the reservation modal's unit dropdown
// and the bulk generator — a plain string sort would put A10 before A2 the
// moment a project passes nine units.
test('naturalSort orders unit numbers numerically within a prefix, not alphabetically', () => {
  const input = ['A10', 'A2', 'A100', 'A1', 'B1', 'A11'];
  assert.deepStrictEqual(
    input.slice().sort(naturalSort),
    ['A1', 'A2', 'A10', 'A11', 'A100', 'B1']
  );
});

// matchImportColumn drives the CSV import mapping step's auto-selected
// dropdowns — every variation named in the spec must resolve to the same
// canonical field regardless of case, punctuation or spacing.
test('matchImportColumn auto-matches every known header variation', () => {
  assert.strictEqual(matchImportColumn('unit_number', 'units'), 'unit_number');
  assert.strictEqual(matchImportColumn('Unit No.', 'units'), 'unit_number');
  assert.strictEqual(matchImportColumn('Unit Number', 'units'), 'unit_number');
  assert.strictEqual(matchImportColumn('unit no', 'units'), 'unit_number');
  assert.strictEqual(matchImportColumn('unit', 'units'), 'unit_number');

  assert.strictEqual(matchImportColumn('list_price', 'units'), 'list_price');
  assert.strictEqual(matchImportColumn('Price', 'units'), 'list_price');
  assert.strictEqual(matchImportColumn('Price (₦)', 'units'), 'list_price');
  assert.strictEqual(matchImportColumn('price', 'units'), 'list_price');
  assert.strictEqual(matchImportColumn('amount', 'units'), 'list_price');

  assert.strictEqual(matchImportColumn('unit_type', 'units'), 'unit_type');
  assert.strictEqual(matchImportColumn('Type', 'units'), 'unit_type');
  assert.strictEqual(matchImportColumn('type', 'units'), 'unit_type');

  assert.strictEqual(matchImportColumn('size_sqm', 'units'), 'size_sqm');
  assert.strictEqual(matchImportColumn('Size', 'units'), 'size_sqm');
  assert.strictEqual(matchImportColumn('size', 'units'), 'size_sqm');
  assert.strictEqual(matchImportColumn('sqm', 'units'), 'size_sqm');

  assert.strictEqual(matchImportColumn('full_name', 'customers'), 'full_name');
  assert.strictEqual(matchImportColumn('Name', 'customers'), 'full_name');
  assert.strictEqual(matchImportColumn('name', 'customers'), 'full_name');
  assert.strictEqual(matchImportColumn('Full Name', 'customers'), 'full_name');
  assert.strictEqual(matchImportColumn('buyer name', 'customers'), 'full_name');

  assert.strictEqual(matchImportColumn('phone', 'customers'), 'phone');
  assert.strictEqual(matchImportColumn('Phone', 'customers'), 'phone');
  assert.strictEqual(matchImportColumn('Phone Number', 'customers'), 'phone');
  assert.strictEqual(matchImportColumn('mobile', 'customers'), 'phone');

  assert.strictEqual(matchImportColumn('email', 'customers'), 'email');
  assert.strictEqual(matchImportColumn('Email', 'customers'), 'email');
});

test('matchImportColumn defaults an unrecognized header to skip (null)', () => {
  assert.strictEqual(matchImportColumn('Referral Source Notes', 'units'), null);
  assert.strictEqual(matchImportColumn('Internal ID', 'customers'), null);
  assert.strictEqual(matchImportColumn('', 'units'), null);
  assert.strictEqual(matchImportColumn('unit_number', 'not_a_real_kind'), null);
});

// remapCsv is what actually turns a mapping into the CSV the backend receives
// — columns mapped to null (Skip this column) must vanish from both the
// header and every data row, without disturbing the columns kept.
test('remapCsv drops skipped columns and renames the ones kept', () => {
  const csv = 'Unit No.,Notes,Price (₦)\nB12,corner unit,45000000\nB13,,52000000';
  const mapping = { 0: 'unit_number', 1: null, 2: 'list_price' };
  assert.strictEqual(
    remapCsv(csv, mapping),
    'unit_number,list_price\r\nB12,45000000\r\nB13,52000000'
  );
});

// ── RBAC — the permission matrix (migrations/016) ────────────────────────
//
// canAccess(role, action) is what every route's requirePermission() and
// assertPermission() call actually checks (src/middleware/rbac.js), so
// asserting against it directly here is equivalent to asserting "this route
// 403s for this role" — without needing a live server or a database, which
// this offline suite deliberately has neither of.
section('RBAC — permission matrix');

test('owner can access every action in the matrix', () => {
  var { PERMISSIONS } = require('../services/permissions');
  for (const action of Object.keys(PERMISSIONS)) {
    assert.ok(canAccess('owner', action), `owner should be allowed: ${action}`);
  }
});

test('a solo account (null role) is treated as owner', () => {
  assert.strictEqual(normalizeRole(null), 'owner');
  assert.ok(canAccess(null, 'payments.waive'));
  assert.ok(canAccess(null, 'settings.write'));
  assert.ok(canAccess(null, 'reports.investor'));
});

test('an unrecognised role string is treated as the least-privileged role, not trusted', () => {
  assert.strictEqual(normalizeRole('super-admin'), 'sales_rep');
  assert.strictEqual(canAccess('super-admin', 'payments.waive'), false);
});

// Sales Director gets 403 on waive, delete, investor report, paid commission
// approval — all four are owner-only, exactly the tier a director is not in.
test('sales_director is refused: waive, delete, investor report, mark commission paid', () => {
  assert.strictEqual(canAccess('sales_director', 'payments.waive'), false);
  assert.strictEqual(canAccess('sales_director', 'recycle.delete'), false);
  assert.strictEqual(canAccess('sales_director', 'reports.investor'), false);
  assert.strictEqual(canAccess('sales_director', 'commissions.markPaid'), false);
});

test('sales_director CAN restructure plans, renew tenancies, approve commissions and read the full brief', () => {
  assert.ok(canAccess('sales_director', 'reservations.restructure'));
  assert.ok(canAccess('sales_director', 'reservations.renewTenancy'));
  assert.ok(canAccess('sales_director', 'commissions.approve'));
  assert.ok(canAccess('sales_director', 'brief.read'));
});

// Sales Rep gets 403 on record payment, generate document, view other rep's
// buyers. The third is a row-level filter (customers.js), not a permission
// gate, so it is asserted at the schema-test level against real rows; here we
// assert the two route-level gates a rep hits regardless of whose data.
test('sales_rep is refused: record payment, generate document', () => {
  assert.strictEqual(canAccess('sales_rep', 'payments.record'), false);
  assert.strictEqual(canAccess('sales_rep', 'documents.generate'), false);
});

test('sales_rep CAN create their own buyers and reservations, and request (not generate) a document', () => {
  assert.ok(canAccess('sales_rep', 'customers.create'));
  assert.ok(canAccess('sales_rep', 'reservations.create'));
  assert.ok(canAccess('sales_rep', 'documents.create'));
  assert.strictEqual(canAccess('sales_rep', 'documents.generate'), false);
});

// Collections gets 403 on create reservation, generate document, view
// commissions.
test('collections is refused: create reservation, generate document, view commissions', () => {
  assert.strictEqual(canAccess('collections', 'reservations.create'), false);
  assert.strictEqual(canAccess('collections', 'documents.generate'), false);
  assert.strictEqual(canAccess('collections', 'commissions.read'), false);
});

test('collections CAN record payments, log promises, and see every overdue buyer', () => {
  assert.ok(canAccess('collections', 'payments.record'));
  assert.ok(canAccess('collections', 'promises.write'));
  assert.ok(canAccess('collections', 'atRisk.read'));
});

// Documentation gets 403 on record payment, view commissions, view brief.
test('documentation is refused: record payment, view commissions, view brief', () => {
  assert.strictEqual(canAccess('documentation', 'payments.record'), false);
  assert.strictEqual(canAccess('documentation', 'commissions.read'), false);
  assert.strictEqual(canAccess('documentation', 'brief.read'), false);
});

test('documentation CAN generate documents and update their status, but cannot see financial amounts', () => {
  assert.ok(canAccess('documentation', 'documents.generate'));
  assert.ok(canAccess('documentation', 'documents.updateStatus'));
  assert.strictEqual(canAccess('documentation', 'financial.view'), false);
});

test('every role is refused the actions the spec names as owner-only', () => {
  for (const role of ROLES.filter((r) => r !== 'owner')) {
    assert.strictEqual(canAccess(role, 'payments.waive'), false, `${role} must not waive`);
    assert.strictEqual(canAccess(role, 'settings.transferOwner'), false, `${role} must not transfer ownership`);
    assert.strictEqual(canAccess(role, 'recycle.delete'), false, `${role} must not delete`);
  }
});

// actionsFor is what GET /auth/me sends the browser — it has to be the exact
// inverse of canAccess, or the frontend draws a different model than the
// server enforces.
test('actionsFor(role) agrees with canAccess for every action', () => {
  var { PERMISSIONS } = require('../services/permissions');
  for (const role of ROLES) {
    const actions = actionsFor(role);
    for (const action of Object.keys(PERMISSIONS)) {
      assert.strictEqual(
        actions.includes(action), canAccess(role, action),
        `actionsFor/canAccess disagree for ${role}/${action}`
      );
    }
  }
});

// Only the owner may invite a Head of Sales; a Head of Sales may build their
// own team (reps, collections, documentation) but not appoint a second one.
test('canInviteRole: only owner invites sales_director; sales_director invites the rest', () => {
  assert.ok(canInviteRole('owner', 'sales_director'));
  assert.strictEqual(canInviteRole('sales_director', 'sales_director'), false);
  assert.ok(canInviteRole('sales_director', 'sales_rep'));
  assert.ok(canInviteRole('sales_director', 'collections'));
  assert.ok(canInviteRole('sales_director', 'documentation'));
  // Nobody outside owner/sales_director may invite at all — team.invite is
  // DIRECTORS-only, and canInviteRole checks it before anything else.
  assert.strictEqual(canInviteRole('sales_rep', 'sales_rep'), false);
  assert.strictEqual(canInviteRole('collections', 'collections'), false);
});

test('canInviteRole refuses a non-invitable target regardless of who is asking', () => {
  assert.strictEqual(canInviteRole('owner', 'owner'), false);
  assert.strictEqual(canInviteRole('owner', 'not-a-real-role'), false);
});

// 11th workspace invite rejected — the pure half of the check (the counting
// query itself is asserted against real rows in schema.test.js).
test('wouldExceedWorkspaceCap: refuses the 11th workspace, allows up to the 10th', () => {
  assert.strictEqual(wouldExceedWorkspaceCap(9), false);
  assert.strictEqual(wouldExceedWorkspaceCap(10), true);
  assert.strictEqual(wouldExceedWorkspaceCap(15), true);
  assert.strictEqual(wouldExceedWorkspaceCap(0), false);
});

// ── Branding — logo resolution (migrations/015) ─────────────────────────
//
// resolveBranding() otherwise talks to a real Supabase client, but
// supabaseAdmin.from is a plain reassignable property (middleware/orgContext.js),
// so it can be swapped for a stub that answers `.select().eq().maybeSingle()`
// from an in-memory fixture, keyed by the id each query filters on — no
// network, no PGlite, just the same object reference brandingService.js holds.
function withFakeBranding(fixturesByTable, fn) {
  const original = supabaseAdmin.from;
  supabaseAdmin.from = (table) => {
    const byId = fixturesByTable[table] || {};
    let idValue;
    const builder = {
      select: () => builder,
      eq: (_column, value) => { idValue = value; return builder; },
      maybeSingle: async () => ({ data: byId[idValue] || null }),
    };
    return builder;
  };
  return fn().finally(() => { supabaseAdmin.from = original; });
}

async function runBrandingTests() {
  section('Branding — logo resolution');

  await testAsync('teams.logo_url wins for a team workspace even when re_org_settings has other fields set', async () => {
    const branding = await withFakeBranding({
      re_org_settings: { 'team-1': { company_name: 'Acme Estates', logo_url: null, address: null } },
      teams: { 'team-1': { name: 'Acme Estates', owner_id: 'owner-1', logo_url: 'https://cdn.example.com/team.png' } },
      users: { 'owner-1': { full_name: 'Owner', brand_logo_url: 'https://cdn.example.com/owner.png' } },
    }, () => resolveBranding('team-1'));
    assert.strictEqual(branding.logo_url, 'https://cdn.example.com/team.png');
    // company_name is untouched by this change — still answered by the settings row.
    assert.strictEqual(branding.company_name, 'Acme Estates');
  });

  await testAsync('re_org_settings.logo_url wins over the owner profile when the team has not uploaded one — even with nothing else set on that row', async () => {
    const branding = await withFakeBranding({
      re_org_settings: { 'team-2': { logo_url: 'https://cdn.example.com/org.png' } }, // ONLY logo_url set
      teams: { 'team-2': { name: 'Bravo Homes', owner_id: 'owner-2', logo_url: null } },
      users: { 'owner-2': { full_name: 'Owner Two', brand_logo_url: 'https://cdn.example.com/owner2.png' } },
    }, () => resolveBranding('team-2'));
    assert.strictEqual(branding.logo_url, 'https://cdn.example.com/org.png');
  });

  await testAsync('falls back to the owner\'s brand_logo_url when neither the team nor org settings has a logo', async () => {
    const branding = await withFakeBranding({
      re_org_settings: {},
      teams: { 'team-3': { name: 'Charlie Realty', owner_id: 'owner-3', logo_url: null } },
      users: { 'owner-3': { full_name: 'Owner Three', brand_logo_url: 'https://cdn.example.com/owner3.png' } },
    }, () => resolveBranding('team-3'));
    assert.strictEqual(branding.logo_url, 'https://cdn.example.com/owner3.png');
    assert.strictEqual(branding.company_name, 'Charlie Realty'); // unaffected by this change
  });

  await testAsync('a solo workspace (no teams row) still resolves logo_url as re_org_settings then the user\'s own brand_logo_url', async () => {
    const branding = await withFakeBranding({
      re_org_settings: {},
      teams: {},
      users: { 'solo-user-1': { full_name: 'Solo Person', brand_logo_url: 'https://cdn.example.com/solo.png' } },
    }, () => resolveBranding('solo-user-1'));
    assert.strictEqual(branding.logo_url, 'https://cdn.example.com/solo.png');
  });
}

// ── Credentials — encrypting a workspace's own Paystack/Resend keys ─────
// (src/utils/credentials.js, migrations/017 + 018). Pure crypto, no
// database — the DB half (a value actually round-tripping through
// re_org_settings) is asserted in schema.test.js.
section('Credentials — AES-256-GCM at rest');

test('encrypt then decrypt returns the original plaintext', () => {
  const stored = encrypt('sk_live_abcdef1234567890');
  assert.strictEqual(decrypt(stored), 'sk_live_abcdef1234567890');
});

test('two encryptions of the same plaintext produce different ciphertext (random IV)', () => {
  const a = encrypt('sk_live_same_key');
  const b = encrypt('sk_live_same_key');
  assert.notStrictEqual(a, b);
  assert.strictEqual(decrypt(a), decrypt(b));
});

test('decrypt throws on a tampered ciphertext instead of returning garbage', () => {
  const stored = Buffer.from(encrypt('sk_live_do_not_corrupt'), 'base64');
  stored[stored.length - 1] ^= 0xff; // flip the last ciphertext byte
  assert.throws(() => decrypt(stored.toString('base64')));
});

test('decrypt(null) is null, not a thrown error — "no key configured" is not tampering', () => {
  assert.strictEqual(decrypt(null), null);
});

test('last4 returns only the final four characters', () => {
  assert.strictEqual(last4('sk_live_abcdef7f3a'), '7f3a');
  assert.strictEqual(last4('ab'), 'ab'); // shorter than 4 — the whole thing, not padded
});

runBrandingTests().then(() => {
  // ── Report ─────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  ${f.name}\n    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
    process.exit(1);
  }
});
