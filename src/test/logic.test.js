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
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');

const { buildSchedule, addMonthsUTC } = require('../services/installmentService');
const {
  parseInstallmentReference, isRealEstateReference, buildReference,
  verifyWebhookSignature, handleRealEstateCharge,
} = require('../services/paystackService');
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
const { STAGES, stageForOverdueCount, describeStage, isAtRisk } = require('../services/escalationService');
const { normalizeNigerianPhone, substituteTemplateVariables, EMAIL_TEMPLATE_TYPES } = require('../services/notificationService');
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
  isDowngrade, capabilitiesLostGoingFrom,
} = require('../services/permissions');
const { encrypt, decrypt, last4 } = require('../utils/credentials');
const {
  MILESTONE_NAMES, sequenceProgressPercent, currentMilestoneSummary,
} = require('../services/constructionService');
const {
  WEIGHTS, computeFromHistory, tier, assessDefaultRisk, OVERDUE_RISK_OVERRIDE_THRESHOLD,
} = require('../services/creditScoreService');
const { allocateCredit } = require('../services/referralService');
const { buildFallbackForecast, resolveRefs: resolveForecastRefs } = require('../services/forecastService');
const { buildFallbackRecommendation } = require('../services/planRecommendationService');
const {
  SIGNABLE_DOC_TYPES, fillPlaceholders, verifySigningToken,
} = require('../services/documentService');
const { INTENTS, keywordIntent } = require('../services/whatsappBotService');
const {
  extractPromisedDate, WILL_PAY_RE, ALREADY_PAID_RE, CANNOT_PAY_RE,
} = require('../services/collectionsAgent');
const { requestPause } = require('../services/hardshipService');
const { scale: projectHealthScale, WARNING_THRESHOLD, CRITICAL_THRESHOLD } = require('../services/projectHealthService');
const { isEligible: isFinancingEligible } = require('../services/financingService');
const exchangeRateService = require('../services/exchangeRateService');
const { bucketFor, MAX_MESSAGES_PER_LEAD } = require('../services/salesAgent');
const { isDue: financeIsDue, collectRecipientEmails } = require('../services/financeAgent');
const { isDue: marketIntelIsDue } = require('../services/marketIntelAgent');
const { authenticate } = require('../middleware/auth');
// Route files export only `router` normally — these three attach a couple of
// extra properties purely so this offline suite can assert on their pure
// logic directly (stripFinancials, the audit financial-redaction helper, the
// webhook's permanent-error classification set) without needing a live
// Express server or a database.
const reservationsRouter = require('../routes/reservations');
const auditRouter = require('../routes/audit');
const webhooksRouter = require('../routes/webhooks');
const reportsRouter = require('../routes/reports');

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
const { buildChecklist } = require('../services/onboardingService');
const { detectSignature } = require('../services/documentStorage');

// SECTION 14 — offline-queue.js loads after realestate.js (needs
// window.RE) and never touches `document` at its own top level (only
// inside functions called at boot/use time, none of which run here), so
// unlike the two files above it does not even need the try/catch — see
// this file's own header comment on why the service worker it pairs with
// has no such seam and is therefore NOT tested here.
require('../../frontend/offline-queue.js');
const { buildEntry, sortByQueuedAt, summarize } = global.window.RE.offlineQueue;

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

section('Onboarding checklist');

test('a pending team invitation completes the invite step, while the owner alone does not', () => {
  const base = {
    projectCount: 0, unitCount: 0, buyerCount: 0, reservationCount: 0,
    paymentCount: 0, settings: null, briefCount: 0,
  };
  const solo = buildChecklist({ ...base, memberOrInviteCount: 1 });
  const invited = buildChecklist({ ...base, memberOrInviteCount: 2 });

  assert.strictEqual(solo.steps.find((step) => step.key === 'team_invited').done, false);
  assert.strictEqual(invited.steps.find((step) => step.key === 'team_invited').done, true);
  assert.strictEqual(invited.completed_count, 1);
  assert.strictEqual(invited.total_count, 8);
});

section('Upload content sniffing');

test('detectSignature reads the real format from the bytes, not the filename', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
  const pdf = Buffer.from('%PDF-1.4\n%...');

  assert.strictEqual(detectSignature(png), 'image/png');
  assert.strictEqual(detectSignature(jpeg), 'image/jpeg');
  assert.strictEqual(detectSignature(webp), 'image/webp');
  assert.strictEqual(detectSignature(pdf), 'application/pdf');
});

test('detectSignature refuses a file whose bytes do not match any known format', () => {
  // The exact scenario the finding this fixes described: a caller can claim
  // any Content-Type on the wire, but the bytes of an HTML/script payload
  // (or anything else) never satisfy a real PNG/JPEG/WebP/PDF header.
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.strictEqual(detectSignature(html), null);
  assert.strictEqual(detectSignature(Buffer.alloc(0)), null);
});

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

// ── Webhook signature verification — cross-workspace fraud ───────────────
// (src/services/paystackService.js: verifyWebhookSignature, allConfiguredSecretKeys,
// handleRealEstateCharge). A live signature check against a real Paystack
// account can't run offline, so this exercises the exact logic that changed —
// which principal a matching key identifies, and that handleRealEstateCharge
// refuses to credit a schedule that does not belong to the workspace whose
// key actually signed the event — against constructed inputs and a stubbed
// supabaseAdmin, the same technique the branding tests below use.
//
// supabaseAdmin.from is a plain reassignable property, so it can be swapped
// per-table for the duration of one test and restored after.
function withFakePaystackTables(tables, fn) {
  const original = supabaseAdmin.from;
  supabaseAdmin.from = (table) => {
    if (Object.prototype.hasOwnProperty.call(tables, table)) return tables[table]();
    throw new Error(`unexpected table in test stub: ${table}`);
  };
  return fn().finally(() => { supabaseAdmin.from = original; });
}

// A minimal chainable query builder: every non-terminal call returns itself,
// and it resolves to `result` however it is awaited — with or without a
// trailing .maybeSingle()/.single() — because the real code sometimes awaits
// the query directly and sometimes awaits one more method on top of it.
function fakeQuery(result) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    order: () => builder,
    is: () => builder,
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

async function runPaystackWebhookOrgTests() {
  section('Webhook signature verification — return shape + cross-workspace org check (paystackService.js)');

  await testAsync('verifyWebhookSignature returns WHICH workspace key matched, not a bare boolean', async () => {
    const orgAKey = 'sk_test_orgA_1234567890';
    const orgBKey = 'sk_test_orgB_abcdefghij';
    const orgSettingsRows = [
      { organization_id: 'org-a', paystack_secret_key_encrypted: encrypt(orgAKey) },
      { organization_id: 'org-b', paystack_secret_key_encrypted: encrypt(orgBKey) },
    ];
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'REINST-x' } }));
    const signedByOrgB = crypto.createHmac('sha512', orgBKey).update(rawBody).digest('hex');

    await withFakePaystackTables(
      { re_org_settings: () => fakeQuery({ data: orgSettingsRows }) },
      async () => {
        const matched = await verifyWebhookSignature(rawBody, signedByOrgB);
        assert.strictEqual(matched.verified, true);
        assert.strictEqual(matched.matchedOrgId, 'org-b', 'must identify org-b specifically, not just "some key matched"');

        const noMatch = await verifyWebhookSignature(rawBody, 'not-a-real-signature');
        assert.strictEqual(noMatch.verified, false);
        assert.strictEqual(noMatch.matchedOrgId, null);
      },
    );
  });

  await testAsync('handleRealEstateCharge refuses an event whose matched workspace key does not own the referenced schedule', async () => {
    const scheduleId = '11111111-1111-4111-8111-111111111111';
    const reference = `REINST-${scheduleId}-1750000000000`;
    const event = { data: { reference, amount: 10_000_00, paid_at: '2026-08-01T00:00:00.000Z' } };
    let insertCalled = false;

    const result = await withFakePaystackTables(
      {
        // Duplicate-reference fast-path check: nothing recorded yet.
        re_payments: () => ({
          ...fakeQuery({ data: null }),
          insert: () => { insertCalled = true; return Promise.resolve({ error: null }); },
        }),
        // The schedule genuinely belongs to org-a.
        re_installment_schedule: () => fakeQuery({ data: { id: scheduleId, organization_id: 'org-a', amount_due: 100000 } }),
      },
      // A key that verified as belonging to org-b tries to settle org-a's schedule.
      () => handleRealEstateCharge(event, { verified: true, matchedOrgId: 'org-b' }),
    );

    assert.strictEqual(insertCalled, false, 'a cross-workspace-key event must never write a payment row');
    assert.strictEqual(result, true, 'still acknowledged (ours by namespace) so Paystack does not retry a mismatch forever');
  });

  await testAsync('handleRealEstateCharge processes normally when the matched key IS the schedule\'s own workspace', async () => {
    const scheduleId = '22222222-2222-4222-8222-222222222222';
    const reference = `REINST-${scheduleId}-1750000000001`;
    const event = { data: { reference, amount: 10_000_00, paid_at: '2026-08-01T00:00:00.000Z' } };
    let insertCalled = false;

    await withFakePaystackTables(
      {
        re_payments: () => ({
          ...fakeQuery({ data: null }),
          insert: () => { insertCalled = true; return Promise.resolve({ error: null }); },
        }),
        re_installment_schedule: () => fakeQuery({ data: { id: scheduleId, organization_id: 'org-a', amount_due: 100000 } }),
      },
      () => handleRealEstateCharge(event, { verified: true, matchedOrgId: 'org-a' }),
    );

    assert.strictEqual(insertCalled, true, 'the schedule\'s own workspace key must still be able to settle its own payment');
  });

  await testAsync('handleRealEstateCharge stays unrestricted when the platform key matched (matchedOrgId null)', async () => {
    const scheduleId = '33333333-3333-4333-8333-333333333333';
    const reference = `REINST-${scheduleId}-1750000000002`;
    const event = { data: { reference, amount: 10_000_00, paid_at: '2026-08-01T00:00:00.000Z' } };
    let insertCalled = false;

    await withFakePaystackTables(
      {
        re_payments: () => ({
          ...fakeQuery({ data: null }),
          insert: () => { insertCalled = true; return Promise.resolve({ error: null }); },
        }),
        re_installment_schedule: () => fakeQuery({ data: { id: scheduleId, organization_id: 'org-a', amount_due: 100000 } }),
      },
      // The platform key matching is null, deliberately unrestricted — this
      // is the path every workspace with no Paystack key of its own has
      // always used, and it must keep working exactly as before.
      () => handleRealEstateCharge(event, { verified: true, matchedOrgId: null }),
    );

    assert.strictEqual(insertCalled, true, 'a platform-key match must remain unrestricted regardless of which org the schedule belongs to');
  });

  await testAsync('handleRealEstateCharge with no verification argument at all behaves exactly as before (no cross-org check)', async () => {
    // Guards backward compatibility for any caller not yet passing verification
    // context through — same pre-fix behaviour, not a new failure mode.
    const scheduleId = '44444444-4444-4444-8444-444444444444';
    const reference = `REINST-${scheduleId}-1750000000003`;
    const event = { data: { reference, amount: 10_000_00, paid_at: '2026-08-01T00:00:00.000Z' } };
    let insertCalled = false;

    await withFakePaystackTables(
      {
        re_payments: () => ({
          ...fakeQuery({ data: null }),
          insert: () => { insertCalled = true; return Promise.resolve({ error: null }); },
        }),
        re_installment_schedule: () => fakeQuery({ data: { id: scheduleId, organization_id: 'org-a', amount_due: 100000 } }),
      },
      () => handleRealEstateCharge(event),
    );

    assert.strictEqual(insertCalled, true);
  });
}

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

// SECTION 15 — carried through from the overdue row so the dashboard's
// "Send all" WhatsApp queue has a number to open per draft, with no second
// buyer lookup.
test('follow_ups carries customer_phone through from the overdue row', () => {
  const withPhone = {
    today: '2026-07-26',
    overdue: [{ reservation_id: 'r1', customer_name: 'Mr Bello', customer_phone: '08031234567', project: 'Lekki Gardens', unit_number: 'A3', amount: 500_000, days_late: 40 }],
    upcomingWeek: [], pendingDocuments: [],
  };
  const brief = buildFallbackBrief(withPhone);
  assert.strictEqual(brief.follow_ups[0].customer_phone, '08031234567');
});

test('follow_ups: a buyer with no phone on file resolves to null, not undefined', () => {
  const brief = buildFallbackBrief(overdueState); // this fixture's rows carry no customer_phone at all
  assert.strictEqual(brief.follow_ups[0].customer_phone, null);
});

// SECTION 2 — yesterday's call/visit notes feed the summary.
test('the summary mentions a buyer called yesterday, and their promise', () => {
  const brief = buildFallbackBrief({
    today: '2026-07-26',
    overdue: [],
    upcomingWeek: [],
    pendingDocuments: [],
    recentActivities: [{
      customer_ref: 'BUYER_1',
      customer_name: 'Mrs Adeyemi',
      activity_type: 'call',
      outcome: 'promised_payment',
      notes: 'Will pay Monday',
    }],
  });
  assert.match(brief.summary, /Mrs Adeyemi was called yesterday and promised payment — "Will pay Monday"/);
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

// FEATURE — the at-risk list's threshold. routes/dashboard.js's GET
// /at-risk filters with this exact function, so asserting isAtRisk(1) is
// true is equivalent to asserting a buyer with exactly one overdue
// installment appears on the at-risk list — the same reasoning the RBAC
// matrix tests above rely on for canAccess().
test('a buyer with exactly 1 overdue installment is at risk (was 2+ before this change)', () => {
  assert.strictEqual(isAtRisk(0), false);
  assert.ok(isAtRisk(1));
  assert.ok(isAtRisk(2));
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
  const idByRef = new Map([['BUYER_1', 'cust-1'], ['BUYER_2', 'cust-2']]);
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

  const resolved = resolveRefs(modelResponse, nameByRef, idByRef);

  assert.strictEqual(resolved.risks[0].customer_name, 'Mrs Adeyemi Okonkwo');
  assert.strictEqual(resolved.risks[0].customer_id, 'cust-1', 'customer_id travels alongside customer_name for the frontend to link to');
  assert.ok(!('customer_ref' in resolved.risks[0]), 'the raw ref must not leak into the stored brief');
  assert.strictEqual(resolved.follow_ups[0].customer_name, 'Mrs Adeyemi Okonkwo');
  assert.strictEqual(resolved.follow_ups[0].customer_id, 'cust-1');
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
  const idByRef = new Map([['BUYER_1', 'cust-1']]);
  const resolved = resolveRefs({
    risks: [{ customer_ref: 'BUYER_9', reason: 'unrecognized ref', severity: 'low' }],
    follow_ups: [], recommendations: [], summary: '',
  }, nameByRef, idByRef);
  assert.strictEqual(resolved.risks[0].customer_name, 'this buyer');
  assert.strictEqual(resolved.risks[0].customer_id, null, 'an unrecognized ref must not resolve to some OTHER buyer\'s id');
});

// SECTION 15 — the dashboard's "Send all" WhatsApp queue needs a phone
// number per draft; phoneByRef carries it through the same never-sent-to-
// OpenAI path idByRef already does for customer_id.
test('resolveRefs carries customer_phone through from phoneByRef, same as customer_id from idByRef', () => {
  const nameByRef = new Map([['BUYER_1', 'Mrs Adeyemi Okonkwo']]);
  const idByRef = new Map([['BUYER_1', 'cust-1']]);
  const phoneByRef = new Map([['BUYER_1', '08031234567']]);
  const resolved = resolveRefs({
    follow_ups: [{ customer_ref: 'BUYER_1', reservation_id: 'r1', whatsapp_draft: 'Hi', email_subject: 'x', email_draft: 'x' }],
    risks: [], recommendations: [], summary: '',
  }, nameByRef, idByRef, phoneByRef);
  assert.strictEqual(resolved.follow_ups[0].customer_phone, '08031234567');
});

test('resolveRefs: a buyer with no phone on file resolves to null, not undefined or a missing key', () => {
  const nameByRef = new Map([['BUYER_1', 'Mrs Adeyemi Okonkwo']]);
  const idByRef = new Map([['BUYER_1', 'cust-1']]);
  const resolved = resolveRefs({
    follow_ups: [{ customer_ref: 'BUYER_1', reservation_id: 'r1', whatsapp_draft: 'Hi', email_subject: 'x', email_draft: 'x' }],
    risks: [], recommendations: [], summary: '',
  }, nameByRef, idByRef); // phoneByRef omitted entirely — the default-empty-Map path
  assert.strictEqual(resolved.follow_ups[0].customer_phone, null);
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

// ── Portal balance — a restructured plan must not double-count ──────────
// (src/services/portalService.js loadPortalAccount). Before the fix, the
// reservation query fetched every plan with no status filter and summed
// plan.total_amount across ALL of them — a restructure's superseded plan
// still holds the FULL original contract value in its own total_amount, so
// it was added on top of the new plan's total_amount (the remaining
// balance), inflating what the buyer's own portal told them they had
// contracted for. Fixture below: ₦10,000,000 contract, ₦4,000,000 paid
// before a restructure, ₦3,000,000 paid after — the buyer should read as
// owing exactly ₦3,000,000, matching the one outstanding installment.
async function runPortalBalanceTests() {
  section('Portal balance — a restructured reservation is not double-counted (portalService.js)');

  function withFakePortalTables(byTable, fn) {
    const original = supabaseAdmin.from;
    supabaseAdmin.from = (table) => {
      const config = byTable[table];
      if (!config) throw new Error(`unexpected table in test stub: ${table}`);
      const builder = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        in: () => builder,
        is: () => builder,
        order: () => builder,
        update: () => builder,
        maybeSingle: async () => config,
        then: (resolve, reject) => Promise.resolve(config).then(resolve, reject),
      };
      return builder;
    };
    return fn().finally(() => { supabaseAdmin.from = original; });
  }

  await testAsync('total_contracted, total_paid and balance all read correctly across a restructure — not inflated, not understated', async () => {
    const oldPlan = {
      id: 'plan-old',
      status: 'superseded',
      total_amount: 10_000_000,       // the FULL original contract — must be skipped, not summed
      original_total_amount: null,
      number_of_installments: 10, frequency: 'monthly', start_date: '2026-01-01',
      re_installment_schedule: [
        // Waived by restructureService when the plan was superseded — not
        // 'pending'/'overdue', so it was already naturally excluded from
        // overdue/next-due math either way.
        { id: 'sched-old-1', installment_number: 1, due_date: '2026-01-01', amount_due: 4_000_000, status: 'waived', paid_at: null },
      ],
    };
    const newPlan = {
      id: 'plan-new',
      status: 'active',
      total_amount: 6_000_000,        // only the REMAINING balance at restructure time
      original_total_amount: 10_000_000, // the contract value survives here
      number_of_installments: 2, frequency: 'monthly', start_date: '2026-05-01',
      re_installment_schedule: [
        { id: 'sched-new-1', installment_number: 1, due_date: '2026-05-01', amount_due: 3_000_000, status: 'paid', paid_at: '2026-05-01' },
        { id: 'sched-new-2', installment_number: 2, due_date: '2026-06-01', amount_due: 3_000_000, status: 'pending', paid_at: null },
      ],
    };
    const reservation = {
      id: 'res-1', status: 'active', reserved_at: '2026-01-01', property_type: 'off_plan',
      tenancy_start_date: null, tenancy_end_date: null,
      re_units: { unit_number: 'A1', unit_type: null, size_sqm: null, list_price: null, re_projects: { name: 'Test Estate', location: null } },
      re_installment_plans: [oldPlan, newPlan],
    };
    const payments = [
      // Paid BEFORE the restructure, against the now-superseded plan's
      // schedule row — must still count toward total_paid.
      { id: 'pay-1', schedule_id: 'sched-old-1', amount: 4_000_000, method: 'bank_transfer', paid_at: '2026-01-15', reallocated_from_payment_id: null },
      // Paid AFTER, against the new plan.
      { id: 'pay-2', schedule_id: 'sched-new-1', amount: 3_000_000, method: 'bank_transfer', paid_at: '2026-05-01', reallocated_from_payment_id: null },
    ];

    const account = await withFakePortalTables(
      {
        re_reservations: { data: [reservation], error: null },
        re_org_settings: { data: null },
        re_documents: { data: [] },
        re_payments: { data: payments },
        re_customers: { data: null, error: null }, // portal_last_seen_at bump
        re_hardship_requests: { data: [] }, // SECTION 4 — per-reservation eligibility read
      },
      () => portal.loadPortalAccount({ id: 'cust-1', organization_id: 'org-1', full_name: 'Buyer One', email: 'b@example.com', phone: '08030000000' }),
    );

    assert.strictEqual(account.summary.total_contracted, 10_000_000, 'contract value must count once (from the live plan), not twice');
    assert.strictEqual(account.summary.total_paid, 7_000_000, 'payments against the superseded plan\'s schedule must still be counted');
    assert.strictEqual(account.summary.balance, 3_000_000, 'matches the one real outstanding installment exactly');
  });
}

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

// SECTION 5 — receipt header/footer customization. What a receipt actually
// STATES (amount, receipt number, installment breakdown) is never part of
// either override — only these two tests assert the boundary; every test
// above already proves the stated facts still render normally regardless.
test('a workspace header_html override replaces the default letterhead, rendered as-is (owner-authored, not escaped)', () => {
  const html = buildReceiptHtml(receiptContext, { company_name: 'Adron Homes' }, 'RCPT-1', {
    header_html: '<div class="my-letterhead"><b>Adron Homes Ltd</b></div>',
  });
  assert.ok(html.includes('<div class="my-letterhead"><b>Adron Homes Ltd</b></div>'), 'the override renders unescaped');
  assert.ok(!html.includes('<div class="company">Adron Homes</div>'), 'the default header is fully replaced, not appended alongside it');
  // What the receipt actually states is untouched by the header override.
  assert.ok(html.includes('₦3,750,000'));
  assert.ok(html.includes('RCPT-1'));
});

test('a workspace footer_html override replaces the default disclaimer/contact line', () => {
  const html = buildReceiptHtml(receiptContext, { address: '12 Admiralty Way, Lekki' }, 'RCPT-1', {
    footer_html: 'Queries: accounts@adronhomes.com',
  });
  assert.ok(html.includes('Queries: accounts@adronhomes.com'));
  assert.ok(!html.includes('12 Admiralty Way'), 'the default contact line is fully replaced');
  assert.ok(!html.includes('computer-generated receipt'), 'the default disclaimer is fully replaced too, not appended alongside the override');
});

test('show_logo: false hides the logo even when the branding has a valid https logo', () => {
  const withLogo = { company_name: 'Adron Homes', logo_url: 'https://cdn.example.com/logo.png' };
  const shown = buildReceiptHtml(receiptContext, withLogo, 'RCPT-1', { show_logo: true });
  const hidden = buildReceiptHtml(receiptContext, withLogo, 'RCPT-1', { show_logo: false });
  assert.ok(shown.includes('cdn.example.com/logo.png'));
  assert.ok(!hidden.includes('cdn.example.com/logo.png'));
});

test('show_developer_address: false drops the contact line but keeps the disclaimer sentence', () => {
  const branding = { company_name: 'Adron Homes', address: '12 Admiralty Way, Lekki', phone: '0803...' };
  const html = buildReceiptHtml(receiptContext, branding, 'RCPT-1', { show_developer_address: false });
  assert.ok(!html.includes('12 Admiralty Way'));
  assert.ok(html.includes('computer-generated receipt and is valid without alteration'));
});

test('no receiptTemplate row (a workspace that never customized this) renders exactly the stock layout', () => {
  const withTemplate = buildReceiptHtml(receiptContext, { company_name: 'Adron Homes' }, 'RCPT-1', null);
  const withoutArg = buildReceiptHtml(receiptContext, { company_name: 'Adron Homes' }, 'RCPT-1');
  assert.strictEqual(withTemplate, withoutArg, 'an explicit null and an omitted 4th argument must behave identically');
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

// ── Email validation (PATCH /auth/me's email-change path) ────────────────
section('Email validation');

test('assertValidEmail accepts a normal address', () => {
  assert.doesNotThrow(() => auth.assertValidEmail('new-address@example.com'));
});

test('assertValidEmail rejects a string with no @ or domain', () => {
  assert.throws(() => auth.assertValidEmail('not-an-email'));
  assert.throws(() => auth.assertValidEmail('missing-domain@'));
  assert.throws(() => auth.assertValidEmail(''));
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

// ── Boot validation ──────────────────────────────────────────────────────
// env.assertRequired() calls process.exit(), so it has to run in a child
// process to be observable — same technique as the timezone-independence
// test above (execFileSync + a tiny inline script).
section('Boot validation — JWT_SECRET strength (src/config/env.js)');

function runEnvAssertRequired(jwtSecret) {
  const script = `
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    process.env.JWT_SECRET = ${JSON.stringify(jwtSecret)};
    const env = require(${JSON.stringify(path.join(__dirname, '../config/env'))});
    env.assertRequired();
    process.stdout.write('BOOTED');
  `;
  try {
    const stdout = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    // execFileSync throws on a non-zero exit; the child's own streams are
    // still attached to the error.
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

test('boots with a long, non-placeholder JWT_SECRET', () => {
  const result = runEnvAssertRequired('a-genuinely-random-secret-that-is-plenty-long-1234567890');
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stdout, 'BOOTED');
});

test('refuses to boot with a JWT_SECRET under 32 characters', () => {
  const result = runEnvAssertRequired('too-short');
  assert.strictEqual(result.code, 1, 'must exit non-zero rather than booting with a weak secret');
  assert.match(result.stderr, /at least 32 characters/);
});

test('refuses to boot with the exact .env.example placeholder JWT_SECRET', () => {
  // The literal string shipped in .env.example — someone who copies the file
  // and forgets to replace this one line must not be able to boot with it.
  const result = runEnvAssertRequired('your-jwt-secret-minimum-32-characters');
  assert.strictEqual(result.code, 1);
  assert.match(result.stderr, /placeholder/);
});

// ── Password hashing — scrypt cost parameters ────────────────────────────
// (src/services/authService.js). Raised from {N:16384,r:8,p:1} to
// {N:65536,r:8,p:2} — this proves new hashes actually use the stronger
// parameters, AND that a hash produced under the OLD parameters (i.e. every
// existing user's row) still verifies: verifyPassword must read N/r/p from
// the stored hash string, never from the live SCRYPT constant, or raising
// this would have signed out (rejected the password of) every existing user
// at once.
async function runAuthServiceTests() {
  section('Password hashing — scrypt cost parameters (src/services/authService.js)');

  await testAsync('hashPassword now stores OWASP-strength parameters (N=65536, r=8, p=2)', async () => {
    const stored = await auth.hashPassword('a-perfectly-reasonable-password-1');
    const [scheme, n, r, p] = stored.split('$');
    assert.strictEqual(scheme, 'scrypt');
    assert.strictEqual(Number(n), 65536);
    assert.strictEqual(Number(r), 8);
    assert.strictEqual(Number(p), 2);
  });

  await testAsync('verifyPassword accepts the right password and rejects the wrong one against a new-parameter hash', async () => {
    const stored = await auth.hashPassword('correct horse battery staple 99');
    assert.strictEqual(await auth.verifyPassword('correct horse battery staple 99', stored), true);
    assert.strictEqual(await auth.verifyPassword('an entirely wrong guess', stored), false);
  });

  await testAsync('verifyPassword still accepts a hash produced under the OLD N=16384,r=8,p=1 parameters — raising the constant does not lock out existing users', async () => {
    // Built independently of authService's own hashPassword/SCRYPT constant,
    // in the exact legacy string shape, so this cannot pass merely because
    // hashPassword and verifyPassword agree with each other — it proves
    // verifyPassword honours whatever N/r/p is actually embedded in a
    // pre-existing row.
    const password = 'a legacy password predating this hardening change';
    const salt = crypto.randomBytes(16);
    const legacyKey = crypto.scryptSync(password.normalize('NFKC'), salt, 64, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    });
    const legacyStored = `scrypt$16384$8$1$${salt.toString('hex')}$${legacyKey.toString('hex')}`;
    assert.strictEqual(await auth.verifyPassword(password, legacyStored), true);
    assert.strictEqual(await auth.verifyPassword('wrong password', legacyStored), false);
  });

  // ── findUserByEmail — exact match, not a LIKE-wildcard match ────────────
  section('findUserByEmail — exact match, not ILIKE (src/services/authService.js)');

  await testAsync('findUserByEmail queries with .eq(), never .ilike() — % and _ in a submitted address must not act as SQL wildcards', async () => {
    const original = supabaseAdmin.from;
    let calledWith = null;
    supabaseAdmin.from = (table) => {
      if (table !== 'users') return original(table);
      const builder = {
        select: () => builder,
        ilike: (column, value) => { calledWith = { method: 'ilike', column, value }; return builder; },
        eq: (column, value) => { calledWith = { method: 'eq', column, value }; return builder; },
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return builder;
    };
    try {
      await auth.findUserByEmail('Someone+Wildcard%@Example.com');
    } finally {
      supabaseAdmin.from = original;
    }
    assert.strictEqual(calledWith?.method, 'eq');
    assert.strictEqual(calledWith?.column, 'email');
    // normalizeEmail lowercases/trims but does not escape % or _ — an exact
    // .eq() match is what makes that safe; .ilike() would have treated the
    // submitted value's own '%' as a wildcard rather than a literal character.
    assert.strictEqual(calledWith?.value, 'someone+wildcard%@example.com');
  });

  // ── Login — lockout must not be an existence oracle ─────────────────────
  section('Login — lockout is not an existence oracle (src/services/authService.js)');

  await testAsync('a locked account and a nonexistent account produce the exact same 401 — never a distinct status for "this account exists and is locked"', async () => {
    const original = supabaseAdmin.from;
    const lockedUser = {
      id: 'user-locked-1',
      email: 'locked@example.com',
      password_hash: await auth.hashPassword('the-real-password-0000'),
      locked_until: new Date(Date.now() + 10 * 60_000).toISOString(),
      failed_login_count: 5,
    };
    supabaseAdmin.from = (table) => {
      if (table !== 'users') return original(table);
      const builder = {
        select: () => builder,
        eq: (column, value) => { builder._email = value; return builder; },
        maybeSingle: async () => ({
          data: builder._email === 'locked@example.com' ? lockedUser : null,
          error: null,
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      return builder;
    };

    try {
      let lockedErr;
      try {
        // Even the CORRECT password must be refused without ever being
        // checked, while the account is locked.
        await auth.login({ email: 'locked@example.com', password: 'the-real-password-0000' });
      } catch (err) { lockedErr = err; }
      assert.ok(lockedErr, 'a locked account must still refuse to sign in');
      assert.strictEqual(lockedErr.statusCode, 401);
      assert.strictEqual(lockedErr.message, 'Incorrect email or password.');

      let missingErr;
      try {
        await auth.login({ email: 'nobody-such-account@example.com', password: 'whatever-guess-0000' });
      } catch (err) { missingErr = err; }
      assert.ok(missingErr);
      assert.strictEqual(missingErr.statusCode, lockedErr.statusCode, 'status code must match the nonexistent-account case exactly');
      assert.strictEqual(missingErr.message, lockedErr.message, 'message must match the nonexistent-account case exactly');
    } finally {
      supabaseAdmin.from = original;
    }
  });
}

// ── Session middleware — team lookup must fail CLOSED on a transient error ──
// (src/middleware/auth.js). The token_version check earlier in the same
// file already fails open ONLY for 42P01/42703 (a genuine schema gap) and
// closed (503) on everything else; the team-membership lookup used to fail
// open on EVERY error, which orgContext.js then reads as req.orgId =
// user.id / req.orgRole = 'owner' — silently demoting a real team member to
// a solo-workspace "owner" of their own id during a transient DB hiccup.
async function runAuthMiddlewareTests() {
  section('Session middleware — team lookup fails closed on a transient error (src/middleware/auth.js)');

  function fakeReqRes(token) {
    const req = { headers: { authorization: `Bearer ${token}` } };
    let statusCode = null;
    let body = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; },
    };
    return { req, res, outcome: () => ({ statusCode, body }) };
  }

  function withFakeAuthLookup({ usersRow, teamMembersError, sessionRow = null }, fn) {
    const original = supabaseAdmin.from;
    supabaseAdmin.from = (table) => {
      if (table === 'users') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: usersRow, error: null }) }) }) };
      }
      if (table === 'team_members') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: null, error: teamMembersError }),
              }),
            }),
          }),
        };
      }
      // SECTION 3 — re_sessions. Defaults to "no existing row" (not
      // revoked) and a harmless no-op thenable for the fire-and-forget
      // upsert — without this branch, the real supabaseAdmin.from would
      // reach out over the network to the dummy Supabase URL every
      // logic.test.js run sets at the top of this file. sessionRow lets an
      // individual test simulate a revoked session.
      if (table === 're_sessions') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: sessionRow, error: null }) }) }),
          upsert: () => Promise.resolve({ data: null, error: null }),
        };
      }
      return original(table);
    };
    return fn().finally(() => { supabaseAdmin.from = original; });
  }

  await testAsync('a transient team-membership lookup error fails CLOSED (503), never silently falls through to a solo-owner session', async () => {
    const token = jwt.sign({ id: 'user-1', tv: 0 }, env.jwt.secret, { algorithm: 'HS256' });
    const { req, res, outcome } = fakeReqRes(token);
    let nextCalled = false;

    await withFakeAuthLookup(
      {
        usersRow: { token_version: 0, email_verified_at: '2026-01-01' },
        teamMembersError: { code: '57014', message: 'canceling statement due to statement timeout' },
      },
      () => authenticate(req, res, () => { nextCalled = true; }),
    );

    assert.strictEqual(nextCalled, false, 'next() must not run — a demoted req.user must never reach a route handler');
    assert.strictEqual(outcome().statusCode, 503);
  });

  await testAsync('a genuinely missing team_members table (42P01) still degrades to a solo account, unchanged', async () => {
    const token = jwt.sign({ id: 'user-1', tv: 0 }, env.jwt.secret, { algorithm: 'HS256' });
    const { req, res, outcome } = fakeReqRes(token);
    let nextCalled = false;

    await withFakeAuthLookup(
      {
        usersRow: { token_version: 0, email_verified_at: '2026-01-01' },
        teamMembersError: { code: '42P01', message: 'relation "team_members" does not exist' },
      },
      () => authenticate(req, res, () => { nextCalled = true; }),
    );

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.user.team_id, null);
    assert.strictEqual(req.user.role, null);
    assert.strictEqual(outcome().statusCode, null, 'no error response was sent — the request proceeded as a solo account');
  });

  // SECTION 3 — a revoked session must 401 even though the JWT signature is
  // still valid and unexpired, the same "a valid signature is not a live
  // session" guarantee token_version already gives every token this user
  // holds, scoped here to just the one token DELETE /auth/sessions/:id
  // targeted.
  section('Session middleware — a revoked session is rejected even with a valid, unexpired signature (src/middleware/auth.js)');

  await testAsync('a token whose re_sessions row is revoked gets 401, and next() never runs', async () => {
    const token = jwt.sign({ id: 'user-1', tv: 0 }, env.jwt.secret, { algorithm: 'HS256' });
    const { req, res, outcome } = fakeReqRes(token);
    let nextCalled = false;

    await withFakeAuthLookup(
      {
        usersRow: { token_version: 0, email_verified_at: '2026-01-01' },
        teamMembersError: null,
        sessionRow: { revoked_at: '2026-01-01T00:00:00.000Z' },
      },
      () => authenticate(req, res, () => { nextCalled = true; }),
    );

    assert.strictEqual(nextCalled, false, 'a revoked session must never reach a route handler');
    assert.strictEqual(outcome().statusCode, 401);
  });

  await testAsync('a token with no re_sessions row yet (first-ever request) proceeds normally', async () => {
    const token = jwt.sign({ id: 'user-1', tv: 0 }, env.jwt.secret, { algorithm: 'HS256' });
    const { req, res, outcome } = fakeReqRes(token);
    let nextCalled = false;

    await withFakeAuthLookup(
      {
        usersRow: { token_version: 0, email_verified_at: '2026-01-01' },
        teamMembersError: null,
        sessionRow: null,
      },
      () => authenticate(req, res, () => { nextCalled = true; }),
    );

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(outcome().statusCode, null);
  });
}

// ── Phone numbers ────────────────────────────────────────────────────────
section('Nigerian phone numbers');

test('normalizes every form a buyer list contains', () => {
  assert.strictEqual(normalizeNigerianPhone('08031234567'), '2348031234567');
  assert.strictEqual(normalizeNigerianPhone('+234 803 123 4567'), '2348031234567');
  assert.strictEqual(normalizeNigerianPhone('234-803-123-4567'), '2348031234567');
  assert.strictEqual(normalizeNigerianPhone('8031234567'), '2348031234567');
  assert.strictEqual(normalizeNigerianPhone(''), null);
});

// waNumber() is the frontend's own normalizer, feeding WhatsApp links
// directly — a different file from notificationService's
// normalizeNigerianPhone above, tested separately because a bug here renders
// a broken link in the browser, not just a malformed outbound SMS.
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
  // A broken link — one WhatsApp opens and then refuses — is worse than no
  // link, because it looks like it should have worked.
  assert.strictEqual(waLink('12345'), null);
  // web.whatsapp.com/send, not wa.me — wa.me hands off to the desktop app,
  // which answers "invalid number" for a genuinely valid one on a machine
  // that has never linked it to a phone. web.whatsapp.com/send stays in the
  // browser instead.
  assert.strictEqual(waLink('08031234567'), 'https://web.whatsapp.com/send?phone=2348031234567');
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

// SECTION 1 — multi-branch/multi-company: folding a workspace into or out of
// a group is owner-level by the same reasoning as turning a solo workspace
// into a team — only sales_director and below are checked here since
// permissions.js already asserts owner passes every action in the matrix.
test('group.manage (create/attach/detach a branch) is owner-only', () => {
  assert.ok(canAccess('owner', 'group.manage'));
  assert.strictEqual(canAccess('sales_director', 'group.manage'), false);
  assert.strictEqual(canAccess('sales_rep', 'group.manage'), false);
  assert.strictEqual(canAccess('collections', 'group.manage'), false);
  assert.strictEqual(canAccess('documentation', 'group.manage'), false);
});

// SECTION 2 — construction milestones: "Add milestone management UI to the
// Projects screen — owner and sales_director only" from the product spec.
// Reading progress stays open to everyone who can read inventory at all
// (inventory.read is ALL), asserted at the route level, not here.
test('construction.manage is owner + sales_director only', () => {
  assert.ok(canAccess('owner', 'construction.manage'));
  assert.ok(canAccess('sales_director', 'construction.manage'));
  assert.strictEqual(canAccess('sales_rep', 'construction.manage'), false);
  assert.strictEqual(canAccess('collections', 'construction.manage'), false);
  assert.strictEqual(canAccess('documentation', 'construction.manage'), false);
});

test('sequenceProgressPercent reads position in the five-stage sequence, not the milestone\'s own completion %', () => {
  // "You are now X% closer to your handover date" — reaching stage 3 of 5
  // (Roofing) is 60% of the way through the SEQUENCE regardless of how far
  // along Roofing's own tracked percentage happens to sit.
  assert.strictEqual(sequenceProgressPercent('Foundation'), 20);
  assert.strictEqual(sequenceProgressPercent('Superstructure'), 40);
  assert.strictEqual(sequenceProgressPercent('Roofing'), 60);
  assert.strictEqual(sequenceProgressPercent('Finishing'), 80);
  assert.strictEqual(sequenceProgressPercent('Handover'), 100);
});

test('MILESTONE_NAMES is the fixed five, in order', () => {
  assert.deepStrictEqual(MILESTONE_NAMES, ['Foundation', 'Superstructure', 'Roofing', 'Finishing', 'Handover']);
});

test('currentMilestoneSummary picks the first not-yet-completed stage', () => {
  const milestones = MILESTONE_NAMES.map((name, i) => ({
    id: `m-${i}`, name, status: i < 2 ? 'completed' : 'pending', completion_percentage: i < 2 ? 100 : 0,
    target_date: null, completed_date: i < 2 ? '2026-01-01' : null, photos: [],
  }));
  const current = currentMilestoneSummary(milestones);
  assert.strictEqual(current.name, 'Roofing'); // first non-completed: index 2
});

test('currentMilestoneSummary falls back to the last stage once every milestone is completed', () => {
  const milestones = MILESTONE_NAMES.map((name) => ({
    id: name, name, status: 'completed', completion_percentage: 100,
    target_date: null, completed_date: '2026-01-01', photos: [],
  }));
  const current = currentMilestoneSummary(milestones);
  assert.strictEqual(current.name, 'Handover');
});

test('currentMilestoneSummary surfaces the LATEST photo, not the first', () => {
  const milestones = [{
    id: 'm-1', name: 'Foundation', status: 'in_progress', completion_percentage: 50,
    target_date: null, completed_date: null,
    photos: [{ url: 'https://x/first.jpg' }, { url: 'https://x/latest.jpg' }],
  }];
  assert.strictEqual(currentMilestoneSummary(milestones).latest_photo_url, 'https://x/latest.jpg');
});

// SECTION 3 — buyer credit scoring. computeFromHistory is the pure core of
// creditScoreService (computeBreakdown/recompute wrap it with a database
// read and write) — fixtures below mirror exactly the shape
// loadCustomerHistory hands it: reservations carrying escalation_stage and
// nested installment schedules, plus a flat promises array.
function schedRow(status, dueDate, paidAt) {
  return { status, due_date: dueDate, paid_at: paidAt };
}
function reservation(stage, rows) {
  return { escalation_stage: stage, re_installment_plans: [{ re_installment_schedule: rows }] };
}

test('computeFromHistory scores a buyer with no history at all as a perfect 100', () => {
  // "Nothing on record" reads as "no problem on record" — a brand-new buyer
  // is not penalised for having no payments, promises or reservations yet.
  const { score, breakdown } = computeFromHistory({ reservations: [], promises: [] });
  assert.strictEqual(score, 100);
  assert.strictEqual(breakdown.payment_consistency.points, WEIGHTS.consistency);
  assert.strictEqual(breakdown.promise_reliability.points, WEIGHTS.promises);
  assert.strictEqual(breakdown.response_rate.points, WEIGHTS.response);
  assert.strictEqual(breakdown.default_history.points, WEIGHTS.defaults);
});

test('computeFromHistory: payment consistency is paid ÷ (paid + overdue + pending past due)', () => {
  // TASK 2.15 — the "future" pending row is 2099, not a date inside this
  // fixture's other rows' 2026 run, on purpose: isPastDue() now actually
  // reads this row's date (the bug fix below), so a date that was future
  // when this fixture was written but has since become the past would
  // silently pull that row into the past-due bucket and break this test
  // out from under whoever runs it later.
  const rows = [
    schedRow('paid', '2026-01-01', '2026-01-01'),   // on time — paid, counts toward the numerator
    schedRow('paid', '2026-02-01', '2026-02-05'),    // paid late — STILL counts toward the numerator (it's paid), but is still a default event
    schedRow('overdue', '2026-03-01', null),          // currently overdue — due, unresolved, a default event
    schedRow('pending', '2099-01-01', null),          // genuinely not yet due — counts toward neither side
  ];
  const { breakdown } = computeFromHistory({ reservations: [reservation('none', rows)], promises: [] });
  assert.strictEqual(breakdown.payment_consistency.total_due, 3, 'denominator is paid + overdue, the not-yet-due pending row excluded');
  assert.strictEqual(breakdown.payment_consistency.on_time, 2, 'numerator is every PAID row, including the one paid late');
  // round(40 * 2/3) = 27
  assert.strictEqual(breakdown.payment_consistency.points, Math.round(WEIGHTS.consistency * (2 / 3)));
  // The late-paid row and the overdue row are still each a default event —
  // "paid" and "was ever late" are tracked separately; this dimension
  // getting more lenient about eventual payment does not erase the lateness.
  assert.strictEqual(breakdown.default_history.default_events, 2);
});

test('computeFromHistory: a pending row past its due date counts as due, even though the sweep has not marked it overdue yet', () => {
  // TASK 2.15 — the actual bug: markOverdue only runs once (twice) a day, so
  // there is always a window where an installment's due_date has passed but
  // its status column still reads 'pending'. The old formula only ever
  // looked at status, so a buyer sitting in that window scored as if
  // nothing were wrong at all — this is what closes that gap.
  const rows = [schedRow('pending', '2020-01-01', null)]; // due date is unambiguously in the past
  const { breakdown } = computeFromHistory({ reservations: [reservation('none', rows)], promises: [] });
  assert.strictEqual(breakdown.payment_consistency.total_due, 1, 'a pending-but-past-due row must count as due');
  assert.strictEqual(breakdown.payment_consistency.on_time, 0);
  assert.strictEqual(breakdown.payment_consistency.points, 0);
  assert.strictEqual(breakdown.default_history.default_events, 1, 'and as a default event, the same as an overdue row');
});

test('computeFromHistory: a buyer with 16 overdue installments against 8 paid scores below 60', () => {
  var rows = [];
  for (var i = 0; i < 8; i++) rows.push(schedRow('paid', '2026-01-01', '2026-01-01'));
  for (var j = 0; j < 16; j++) rows.push(schedRow('overdue', '2026-02-01', null));
  const { score } = computeFromHistory({ reservations: [reservation('legal', rows)], promises: [] });
  assert.ok(score < 60, `expected a score below 60 for 16 overdue against 8 paid, got ${score}`);
});

test('computeFromHistory: promise reliability ignores open and cancelled promises', () => {
  const promises = [
    { status: 'kept' }, { status: 'kept' }, { status: 'broken' },
    { status: 'open' }, { status: 'cancelled' },
  ];
  const { breakdown } = computeFromHistory({ reservations: [], promises });
  assert.strictEqual(breakdown.promise_reliability.resolved, 3); // open + cancelled excluded
  assert.strictEqual(breakdown.promise_reliability.kept, 2);
  // round(20 * 2/3) = 13
  assert.strictEqual(breakdown.promise_reliability.points, Math.round(WEIGHTS.promises * (2 / 3)));
});

test('computeFromHistory: response rate reads the WORST escalation stage across all reservations', () => {
  const withLegal = [reservation('none', []), reservation('legal', [])];
  const { breakdown } = computeFromHistory({ reservations: withLegal, promises: [] });
  // legal is the last of 5 stages (index 4) — worst possible response ratio, 0 points.
  assert.strictEqual(breakdown.response_rate.points, 0);
  assert.strictEqual(breakdown.response_rate.worst_escalation_stage, 'Legal review');
});

test('computeFromHistory: default history is floored at 5 events, never scores negative', () => {
  const rows = Array.from({ length: 8 }, (_, i) => schedRow('overdue', `2026-0${(i % 9) + 1}-01`, null));
  const { score, breakdown } = computeFromHistory({ reservations: [reservation('none', rows)], promises: [] });
  assert.strictEqual(breakdown.default_history.default_events, 8);
  assert.strictEqual(breakdown.default_history.points, 0);
  assert.ok(score >= 0);
});

// SECTION 4 — an approved hardship request costs 15 points, applied by
// RECOMPUTING (creditScoreService.recompute calls computeBreakdown, which
// calls this) rather than by mutating the stored number directly — the only
// way the penalty survives the next payment event recomputing the score
// from scratch.
test('computeFromHistory: an approved hardship request costs 15 points off an otherwise perfect score', () => {
  const clean = computeFromHistory({ reservations: [], promises: [] });
  assert.strictEqual(clean.score, 100);

  const withHardship = computeFromHistory({ reservations: [], promises: [], hardshipCount: 1 });
  assert.strictEqual(withHardship.score, 85);
  assert.strictEqual(withHardship.breakdown.hardship_penalty.points, -15);

  // Stacks per use, but the final score never goes negative.
  const usedFiveTimes = computeFromHistory({ reservations: [], promises: [], hardshipCount: 10 });
  assert.strictEqual(usedFiveTimes.score, 0);
});

// THE BUG — credit_score reading 100 for every buyer regardless of payment
// history. The pure formula below was already correct (these two cases both
// pass against unmodified computeFromHistory); the actual defect was that
// re_customers.credit_score, the STORED column the Buyers list and this
// forecast both read, was only ever refreshed by creditScoreService.recompute
// — and recompute() was wired to a payment being recorded, a promise
// resolving, or a hardship being approved, never to the daily overdue sweep
// itself (overdueService.markOverdue). A buyer who simply stopped paying —
// no payment, no promise, no hardship request against them — never triggered
// any of those, so their score sat at the re_customers default of 100
// forever, no matter how many installments piled up overdue underneath it.
// Fixed by having markOverdue recompute every buyer it just flipped to
// overdue (see overdueService.js's own comment on the fix).
test('computeFromHistory: 16 overdue installments, worst escalation stage, no promises kept scores below 20', () => {
  const rows = Array.from({ length: 16 }, (_, i) => schedRow('overdue', `2026-0${(i % 9) + 1}-01`, null));
  // "No promises kept" is modelled as promises that were made and broken,
  // not as an absence of promises — an absence gets the benefit of the
  // doubt (full 20 points, by design, see the "no history" test above) and
  // could not by itself pull a score under 20. STAGES' worst entry is used
  // rather than a hardcoded index so this stays correct if a stage is ever
  // added or removed.
  const promises = [{ status: 'broken' }, { status: 'broken' }];
  const worstStage = STAGES[STAGES.length - 1].key; // 'legal' — this product's floor
  const { score, breakdown } = computeFromHistory({
    reservations: [reservation(worstStage, rows)],
    promises,
  });
  assert.ok(score < 20, `expected a score below 20 for 16 overdue / worst stage / no promises kept, got ${score}`);
  assert.strictEqual(breakdown.payment_consistency.points, 0);
  assert.strictEqual(breakdown.response_rate.points, 0);
  assert.strictEqual(breakdown.promise_reliability.points, 0);
});

test('computeFromHistory: every payment on time, nothing overdue, scores above 85', () => {
  const rows = Array.from({ length: 12 }, (_, i) => schedRow('paid', `2026-0${(i % 9) + 1}-01`, `2026-0${(i % 9) + 1}-01`));
  const { score } = computeFromHistory({ reservations: [reservation('none', rows)], promises: [] });
  assert.ok(score > 85, `expected a score above 85 for a buyer with a perfect on-time record, got ${score}`);
});

// SECTION 6 — forecastService's default-risk override. A stored
// credit_score can lag a buyer's most recent overdue installments (the bug
// above); assessDefaultRisk is what stops that lag from ever reading as
// reassuring in the forecast text, by forcing 'high' the moment overdue
// installments cross the threshold, independent of the score's own tier.
test('assessDefaultRisk: 3+ overdue installments is high risk regardless of tier', () => {
  assert.strictEqual(OVERDUE_RISK_OVERRIDE_THRESHOLD, 3);
  assert.strictEqual(assessDefaultRisk(3, 'excellent'), 'high');
  assert.strictEqual(assessDefaultRisk(16, 'excellent'), 'high');
  assert.strictEqual(assessDefaultRisk(2, 'excellent'), 'low');
});

test('assessDefaultRisk: below the override threshold, risk follows the credit tier', () => {
  assert.strictEqual(assessDefaultRisk(0, 'excellent'), 'low');
  assert.strictEqual(assessDefaultRisk(0, 'good'), 'low');
  assert.strictEqual(assessDefaultRisk(0, 'fair'), 'medium');
  assert.strictEqual(assessDefaultRisk(0, 'at_risk'), 'high');
});

test('buildFallbackForecast: a buyer over the overdue-risk threshold reads HIGH DEFAULT RISK even with a stale, high credit score', () => {
  const state = {
    today: '2026-01-01',
    overall: { total_overdue_amount: 500_000, default_rate_percent: 12, monthly_collections_last_12: [] },
    projects: [],
    risk_candidates: [
      // credit_score/tier deliberately still read "excellent" — exactly the
      // stale-score state the bug produced — but risk_level was already
      // computed (as gatherForecastState now does) as the override.
      { customer_ref: 'BUYER_1', credit_score: 100, tier: 'excellent', risk_level: 'high', overdue_installments: 16, overdue_amount: 500_000, escalation_stage: 'legal' },
    ],
  };
  const forecast = buildFallbackForecast(state);
  const reason = forecast.default_risks[0].risk_reason;
  assert.match(reason, /^HIGH DEFAULT RISK/, 'must lead with the risk flag, not a reassuring credit score');
  assert.match(reason, /16 installment\(s\) currently overdue/);
  // The raw score/tier still appears further in, for transparency — but not
  // as the FIRST thing read, which is what made the old text misleading.
  assert.match(reason, /credit score 100 \(excellent\)/i);
});

test('tier() matches the product spec\'s four bands exactly at their boundaries', () => {
  assert.strictEqual(tier(100).key, 'excellent');
  assert.strictEqual(tier(80).key, 'excellent');
  assert.strictEqual(tier(79).key, 'good');
  assert.strictEqual(tier(60).key, 'good');
  assert.strictEqual(tier(59).key, 'fair');
  assert.strictEqual(tier(40).key, 'fair');
  assert.strictEqual(tier(39).key, 'at_risk');
  assert.strictEqual(tier(0).key, 'at_risk');
});

// SECTION 5 — buyer referral network. allocateCredit is the pure allocation
// core of referralService.applyCreditToOutstandingBalance — fixtures mirror
// the shape that function builds from the buyer's open schedule rows.
function openRow(id, planId, amountDue, dueDate, status) {
  return { id, plan_id: planId, amount_due: amountDue, due_date: dueDate, status: status || 'pending' };
}

test('allocateCredit fully absorbed by one row leaves it reduced but still owed', () => {
  const rows = [openRow('r1', 'p1', 50000, '2026-03-01')];
  const { rowUpdates, applied, remaining } = allocateCredit(rows, 20000);
  assert.strictEqual(applied, 20000);
  assert.strictEqual(remaining, 0);
  assert.strictEqual(rowUpdates.length, 1);
  assert.strictEqual(rowUpdates[0].amount_due, 30000);
  assert.strictEqual(rowUpdates[0].status, 'pending'); // still owed, not waived
});

test('allocateCredit that exactly covers a row marks it waived, not paid', () => {
  const rows = [openRow('r1', 'p1', 20000, '2026-03-01', 'overdue')];
  const { rowUpdates } = allocateCredit(rows, 20000);
  assert.strictEqual(rowUpdates[0].amount_due, 0);
  assert.strictEqual(rowUpdates[0].status, 'waived');
});

test('allocateCredit applies earliest due_date first, across multiple plans', () => {
  const rows = [
    openRow('later', 'p1', 10000, '2026-06-01'),
    openRow('earlier', 'p2', 10000, '2026-01-01'),
  ];
  // Enough to fully absorb the earlier row and partially the later one.
  const { rowUpdates } = allocateCredit(rows, 15000);
  const earlier = rowUpdates.find((r) => r.id === 'earlier');
  const later = rowUpdates.find((r) => r.id === 'later');
  assert.strictEqual(earlier.amount_due, 0);
  assert.strictEqual(earlier.status, 'waived');
  assert.strictEqual(later.amount_due, 5000);
});

test('allocateCredit exceeding every open row leaves the excess as remaining', () => {
  const rows = [openRow('r1', 'p1', 10000, '2026-01-01')];
  const { applied, remaining } = allocateCredit(rows, 30000);
  assert.strictEqual(applied, 10000);
  assert.strictEqual(remaining, 20000);
});

test('allocateCredit against no open rows applies nothing', () => {
  const { applied, remaining, rowUpdates } = allocateCredit([], 15000);
  assert.strictEqual(applied, 0);
  assert.strictEqual(remaining, 15000);
  assert.strictEqual(rowUpdates.length, 0);
});

test('allocateCredit sums each touched plan\'s delta correctly for two rows on the same plan', () => {
  const rows = [
    openRow('r1', 'p1', 8000, '2026-01-01'),
    openRow('r2', 'p1', 8000, '2026-02-01'),
  ];
  const { planDeltas } = allocateCredit(rows, 12000);
  assert.strictEqual(planDeltas.get('p1'), 12000);
});

test('reports.referrals is owner + sales_director only, same tier as collections/rental', () => {
  assert.ok(canAccess('owner', 'reports.referrals'));
  assert.ok(canAccess('sales_director', 'reports.referrals'));
  assert.strictEqual(canAccess('sales_rep', 'reports.referrals'), false);
  assert.strictEqual(canAccess('collections', 'reports.referrals'), false);
  assert.strictEqual(canAccess('documentation', 'reports.referrals'), false);
});

// SECTION 6 — AI sales forecasting. buildFallbackForecast and resolveRefs
// are the pure parts of forecastService (gatherForecastState/generateForecast
// touch the database and, for the model path, OpenAI — not exercised here).
test('buildFallbackForecast projects flat from the average of the last 3 months on record', () => {
  const state = {
    today: '2026-04-01',
    overall: {
      total_overdue_amount: 0,
      default_rate_percent: 0,
      monthly_collections_last_12: [
        { month: '2026-01', amount: 1_000_000 },
        { month: '2026-02', amount: 2_000_000 },
        { month: '2026-03', amount: 3_000_000 },
      ],
    },
    projects: [],
    risk_candidates: [],
  };
  const forecast = buildFallbackForecast(state);
  // average of 1m, 2m, 3m = 2m
  assert.strictEqual(forecast.projected_collections_3mo.month_1, 2_000_000);
  assert.strictEqual(forecast.projected_collections_3mo.month_2, 2_000_000);
  assert.strictEqual(forecast.projected_collections_3mo.month_3, 2_000_000);
});

test('buildFallbackForecast projects a completion date from remaining balance ÷ 6-month collection rate', () => {
  const state = {
    today: '2026-01-01',
    overall: { total_overdue_amount: 0, default_rate_percent: 0, monthly_collections_last_12: [] },
    projects: [{
      project_ref: 'PROJECT_1', remaining_balance: 3_000_000, avg_monthly_collection_last_6mo: 1_000_000,
    }],
    risk_candidates: [],
  };
  const forecast = buildFallbackForecast(state);
  // 3,000,000 / 1,000,000 = 3 months from 2026-01-01
  assert.strictEqual(forecast.project_completions[0].projected_completion_date, '2026-04-01');
});

test('buildFallbackForecast leaves the completion date null when the project has no recent collections', () => {
  const state = {
    today: '2026-01-01',
    overall: { total_overdue_amount: 0, default_rate_percent: 0, monthly_collections_last_12: [] },
    projects: [{ project_ref: 'PROJECT_1', remaining_balance: 3_000_000, avg_monthly_collection_last_6mo: 0 }],
    risk_candidates: [],
  };
  const forecast = buildFallbackForecast(state);
  assert.strictEqual(forecast.project_completions[0].projected_completion_date, null);
});

test('buildFallbackForecast ranks default risks in the order risk_candidates were given (worst-first is the caller\'s job)', () => {
  const state = {
    today: '2026-01-01',
    overall: { total_overdue_amount: 500_000, default_rate_percent: 12, monthly_collections_last_12: [] },
    projects: [],
    risk_candidates: [
      { customer_ref: 'BUYER_1', credit_score: 30, tier: 'at_risk', overdue_installments: 3, overdue_amount: 500_000, escalation_stage: 'legal' },
      { customer_ref: 'BUYER_2', credit_score: 70, tier: 'good', overdue_installments: 0, overdue_amount: 0, escalation_stage: 'none' },
    ],
  };
  const forecast = buildFallbackForecast(state);
  assert.strictEqual(forecast.default_risks.length, 2);
  assert.strictEqual(forecast.default_risks[0].customer_ref, 'BUYER_1');
  assert.match(forecast.default_risks[0].risk_reason, /overdue/i);
  assert.match(forecast.default_risks[1].risk_reason, /no installments currently overdue/i);
});

test('resolveRefs swaps project_ref/customer_ref tokens for real names and never leaks the token itself', () => {
  const nameByProjectRef = new Map([['PROJECT_1', 'Lekki Gardens Phase 2']]);
  const nameByCustomerRef = new Map([['BUYER_1', 'Mrs Adeyemi Okonkwo']]);
  const raw = {
    projected_collections_3mo: { month_1: 1, month_2: 1, month_3: 1, reasoning: 'x' },
    project_completions: [{ project_ref: 'PROJECT_1', projected_completion_date: null, reasoning: 'x' }],
    default_risks: [{ customer_ref: 'BUYER_1', risk_reason: 'x' }],
    recommended_actions: [],
  };
  const resolved = resolveForecastRefs(raw, nameByProjectRef, nameByCustomerRef);
  assert.strictEqual(resolved.project_completions[0].project_name, 'Lekki Gardens Phase 2');
  assert.strictEqual(resolved.default_risks[0].customer_name, 'Mrs Adeyemi Okonkwo');
  assert.strictEqual(resolved.project_completions[0].project_ref, undefined);
  assert.strictEqual(resolved.default_risks[0].customer_ref, undefined);
});

test('reports.forecast is owner-only, same tier as reports.investor', () => {
  assert.ok(canAccess('owner', 'reports.forecast'));
  assert.strictEqual(canAccess('sales_director', 'reports.forecast'), false);
  assert.strictEqual(canAccess('sales_rep', 'reports.forecast'), false);
});

// SECTION 7 — smart payment plan AI. buildFallbackRecommendation is the pure
// tier-based heuristic used with no OPENAI_API_KEY or on a failed model call
// (planRecommendationService.gatherPlanState/recommendPlan touch the
// database and, for the model path, OpenAI — not exercised here).
test('buildFallbackRecommendation shortens the plan and raises the deposit as credit tier worsens', () => {
  const excellent = buildFallbackRecommendation({ buyer_credit_score: 90, buyer_credit_tier: 'excellent' });
  const atRisk = buildFallbackRecommendation({ buyer_credit_score: 20, buyer_credit_tier: 'at_risk' });
  assert.ok(atRisk.recommended_installments < excellent.recommended_installments);
  assert.ok(atRisk.recommended_deposit_percent > excellent.recommended_deposit_percent);
  assert.strictEqual(excellent.recommended_frequency, 'monthly');
  assert.strictEqual(atRisk.recommended_frequency, 'monthly');
});

test('buildFallbackRecommendation stays within the schema\'s bounds for every tier', () => {
  for (const tier of ['excellent', 'good', 'fair', 'at_risk']) {
    const rec = buildFallbackRecommendation({ buyer_credit_score: 50, buyer_credit_tier: tier });
    assert.ok(rec.recommended_installments >= 1 && rec.recommended_installments <= 120);
    assert.ok(rec.recommended_deposit_percent >= 0 && rec.recommended_deposit_percent <= 100);
    assert.ok(['monthly', 'quarterly'].includes(rec.recommended_frequency));
    assert.ok(rec.reasoning.length > 0);
  }
});

test('buildFallbackRecommendation defaults to the "good" heuristic for an unrecognised tier', () => {
  const rec = buildFallbackRecommendation({ buyer_credit_score: 65, buyer_credit_tier: 'unknown' });
  const good = buildFallbackRecommendation({ buyer_credit_score: 65, buyer_credit_tier: 'good' });
  assert.strictEqual(rec.recommended_installments, good.recommended_installments);
  assert.strictEqual(rec.recommended_deposit_percent, good.recommended_deposit_percent);
});

// SECTION 8 — legal document automation + e-signature.
test('SIGNABLE_DOC_TYPES is exactly the three contract types a buyer must countersign', () => {
  assert.deepStrictEqual(
    [...SIGNABLE_DOC_TYPES].sort(),
    ['deed_of_assignment', 'power_of_attorney', 'subscriber_agreement'].sort()
  );
});

test('fillPlaceholders escapes ordinary values but leaves rawKeys HTML intact', () => {
  const out = fillPlaceholders(
    '<p>{{buyer_name}}</p>{{signature_block}}',
    { buyer_name: '<script>alert(1)</script>', signature_block: '<img src="x.png">' },
    ['signature_block']
  );
  assert.ok(out.includes('&lt;script&gt;'), 'buyer_name was escaped');
  assert.ok(!out.includes('<script>'), 'raw script tag did not survive');
  assert.ok(out.includes('<img src="x.png">'), 'signature_block was inserted as raw HTML');
});

test('fillPlaceholders substitutes every occurrence of a repeated token', () => {
  const out = fillPlaceholders('{{unit_number}} / {{unit_number}}', { unit_number: 'A12' });
  assert.strictEqual(out, 'A12 / A12');
});

test('fillPlaceholders leaves an unrecognised token alone rather than blanking it', () => {
  const out = fillPlaceholders('{{buyer_name}} {{something_else}}', { buyer_name: 'Ada' });
  assert.strictEqual(out, 'Ada {{something_else}}');
});

test('verifySigningToken accepts a token minted for the document-signing audience', () => {
  const token = jwt.sign({ did: 'doc-1', org: 'org-1' }, env.jwt.secret, {
    algorithm: 'HS256', audience: 're-document-sign', expiresIn: '14d',
  });
  const claims = verifySigningToken(token);
  assert.strictEqual(claims.did, 'doc-1');
  assert.strictEqual(claims.org, 'org-1');
});

test('verifySigningToken rejects a staff token (no audience) presented as a signing link', () => {
  const staffToken = auth.issueToken({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'a@b.c' });
  assert.throws(() => verifySigningToken(staffToken));
});

test('verifySigningToken rejects a portal token (aud:re-portal) presented as a signing link', () => {
  const portalToken = portal.issuePortalToken({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    organization_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    portal_token_version: 0,
  });
  assert.throws(() => verifySigningToken(portalToken));
});

test('verifySigningToken rejects an expired token', () => {
  const expired = jwt.sign({ did: 'doc-1', org: 'org-1' }, env.jwt.secret, {
    algorithm: 'HS256', audience: 're-document-sign', expiresIn: '-1s',
  });
  assert.throws(() => verifySigningToken(expired));
});

// SECTION 9 — WhatsApp native mini app. keywordIntent is the deterministic
// fallback used with no OPENAI_API_KEY or on a failed classification call —
// classifyIntent itself delegates straight to it in this offline suite
// (env.openai.apiKey is unset here), so testing both together also proves
// that wiring.
test('INTENTS is exactly the five the product spec names', () => {
  assert.deepStrictEqual([...INTENTS].sort(), [
    'check_balance', 'get_receipt', 'next_payment', 'pay_now', 'speak_to_agent',
  ].sort());
});

test('keywordIntent recognises each of the five intents from plain phrasing', () => {
  assert.strictEqual(keywordIntent('can I get my receipt please'), 'get_receipt');
  assert.strictEqual(keywordIntent('I want to pay online now'), 'pay_now');
  assert.strictEqual(keywordIntent('what is my outstanding balance'), 'check_balance');
  assert.strictEqual(keywordIntent('when is my next payment due'), 'next_payment');
  assert.strictEqual(keywordIntent('my agent never called me back, this is unacceptable'), 'speak_to_agent');
});

test('keywordIntent defaults to speak_to_agent for a genuinely unclear message', () => {
  assert.strictEqual(keywordIntent('hello good morning'), 'speak_to_agent');
  assert.strictEqual(keywordIntent(''), 'speak_to_agent');
});

// SECTION 11 — the five v2 agents + Deal Manager. Only the pure parts are
// exercised offline here — everything else in these five files reads or
// writes the database, sends via notificationService, or calls OpenAI.
section('SECTION 11 — v2 agents');

test('collectionsAgent: WILL_PAY_RE / ALREADY_PAID_RE / CANNOT_PAY_RE match the phrasings they are meant to, and nothing else', () => {
  assert.ok(WILL_PAY_RE.test('I will pay on Friday'));
  assert.ok(WILL_PAY_RE.test("I'll pay by the 15th"));
  assert.strictEqual(WILL_PAY_RE.test('what is my balance'), false);

  assert.ok(ALREADY_PAID_RE.test('I have already paid this'));
  assert.ok(ALREADY_PAID_RE.test('I paid yesterday'));
  assert.strictEqual(ALREADY_PAID_RE.test('I will pay tomorrow'), false);

  assert.ok(CANNOT_PAY_RE.test('I cannot pay this month'));
  assert.ok(CANNOT_PAY_RE.test("I can't pay right now"));
  assert.strictEqual(CANNOT_PAY_RE.test('I will pay Friday'), false);
});

test('collectionsAgent.extractPromisedDate recognises tomorrow, a weekday name, and an explicit date', () => {
  // 2026-01-01 is a Thursday.
  assert.strictEqual(extractPromisedDate('I will pay tomorrow', '2026-01-01'), '2026-01-02');
  assert.strictEqual(extractPromisedDate('I will pay Friday', '2026-01-01'), '2026-01-02');
  assert.strictEqual(extractPromisedDate('I will pay by 15/03', '2026-01-01'), '2026-03-15');
});

test('collectionsAgent.extractPromisedDate defaults to a week out when no date is recognised', () => {
  assert.strictEqual(extractPromisedDate('I will pay soon, please be patient', '2026-01-01'), '2026-01-08');
});

test('collectionsAgent.extractPromisedDate never resolves a weekday to today itself', () => {
  // 2026-01-01 IS a Thursday — "pay Thursday" must mean next week's, not today.
  assert.strictEqual(extractPromisedDate('I will pay Thursday', '2026-01-01'), '2026-01-08');
});

test('salesAgent.bucketFor maps lead age to the right one of three messages', () => {
  assert.strictEqual(bucketFor(0), 'welcome');
  assert.strictEqual(bucketFor(2.9), 'welcome');
  assert.strictEqual(bucketFor(3), 'followup');
  assert.strictEqual(bucketFor(6.9), 'followup');
  assert.strictEqual(bucketFor(7), 'checkin');
  assert.strictEqual(bucketFor(30), 'checkin');
});

test('salesAgent never sends more than 3 messages to one unconverted lead, per the product spec', () => {
  assert.strictEqual(MAX_MESSAGES_PER_LEAD, 3);
});

test('financeAgent.isDue is true only on the 1st of the month, read in Africa/Lagos', () => {
  assert.ok(financeIsDue(new Date('2026-03-01T10:00:00Z')));
  assert.strictEqual(financeIsDue(new Date('2026-03-15T10:00:00Z')), false);
  assert.strictEqual(financeIsDue(new Date('2026-03-31T10:00:00Z')), false);
});

test('financeAgent.collectRecipientEmails combines notify_md_email and investor_emails, de-duplicated', () => {
  const emails = collectRecipientEmails({
    notify_md_email: 'md@company.com',
    investor_emails: 'investor1@x.com, md@company.com , investor2@x.com',
  });
  assert.deepStrictEqual(emails, ['md@company.com', 'investor1@x.com', 'investor2@x.com']);
});

test('financeAgent.collectRecipientEmails returns an empty list when nothing is configured', () => {
  assert.deepStrictEqual(collectRecipientEmails({}), []);
  assert.deepStrictEqual(collectRecipientEmails(null), []);
});

test('marketIntelAgent.isDue is true only on Mondays, read in Africa/Lagos', () => {
  // 2026-01-05 is a Monday.
  assert.ok(marketIntelIsDue(new Date('2026-01-05T10:00:00Z')));
  assert.strictEqual(marketIntelIsDue(new Date('2026-01-06T10:00:00Z')), false);
  assert.strictEqual(marketIntelIsDue(new Date('2026-01-11T10:00:00Z')), false); // Sunday
});

test('sales_director CAN restructure plans, renew tenancies, approve commissions and read the full brief', () => {
  assert.ok(canAccess('sales_director', 'reservations.restructure'));
  assert.ok(canAccess('sales_director', 'reservations.renewTenancy'));
  assert.ok(canAccess('sales_director', 'commissions.approve'));
  assert.ok(canAccess('sales_director', 'brief.read'));
});

// FEATURE — "Change rep" on a reservation, and "Reassign all reservations"
// from a rep's profile, both change whose commission accrues going forward.
// Same DIRECTORS-only tier as restructuring a plan.
test('reservations.reassign is owner/sales_director only', () => {
  assert.ok(canAccess('owner', 'reservations.reassign'));
  assert.ok(canAccess('sales_director', 'reservations.reassign'));
  assert.strictEqual(canAccess('sales_rep', 'reservations.reassign'), false);
  assert.strictEqual(canAccess('collections', 'reservations.reassign'), false);
  assert.strictEqual(canAccess('documentation', 'reservations.reassign'), false);
});

// SECTION 2 — every operational role except Documentation may log a call or
// visit note; routes/customers.js narrows sales_rep further to their own
// buyers only (a row-level check, not part of this matrix).
// FEATURE — hardship review is owner/sales_director only, never automatic
// and never a collections/rep decision (CLAUDE.md's spec for this feature).
// SECTION 9 — "Apply for bank financing" only shows once 30% of the
// buyer's WHOLE account is paid AND their credit score is above 40 — both
// conditions, not either.
test('financing eligibility requires 30%+ paid AND credit score above 40', () => {
  assert.strictEqual(isFinancingEligible({ totalContracted: 10_000_000, totalPaid: 3_000_000, creditScoreValue: 50 }), true);
  assert.strictEqual(isFinancingEligible({ totalContracted: 10_000_000, totalPaid: 2_999_999, creditScoreValue: 50 }), false);
  assert.strictEqual(isFinancingEligible({ totalContracted: 10_000_000, totalPaid: 5_000_000, creditScoreValue: 40 }), false); // exactly 40 is not ABOVE 40
  assert.strictEqual(isFinancingEligible({ totalContracted: 0, totalPaid: 0, creditScoreValue: 100 }), false); // nothing contracted yet
});

// SECTION 11 — handover checklist and snagging: same DIRECTORS tier as
// restructuring a plan or renewing a tenancy, another sales-completion task.
// SECTION 12 — contractors/outflow tracking is owner only, same tier as the
// investor report it sits beside on the Reports screen.
// SECTION 13 — community moderation (read every project's threads, pin,
// remove) is owner/sales_director, same tier as legal.read and other
// oversight-not-authorship actions.
// SECTION 15 — the health score and its signal breakdown are owner only,
// same tier as the investor report.
test('projectHealth.read is owner-only', () => {
  assert.ok(canAccess('owner', 'projectHealth.read'));
  assert.strictEqual(canAccess('sales_director', 'projectHealth.read'), false);
  assert.strictEqual(canAccess('collections', 'projectHealth.read'), false);
});

test('community.moderate is owner/sales_director only', () => {
  assert.ok(canAccess('owner', 'community.moderate'));
  assert.ok(canAccess('sales_director', 'community.moderate'));
  assert.strictEqual(canAccess('sales_rep', 'community.moderate'), false);
  assert.strictEqual(canAccess('collections', 'community.moderate'), false);
});

// SECTION 15 — the abandoned-project health score's shared scaling
// function. Every one of the five signals goes through this, so its own
// correctness (clamped, linear, direction-agnostic) is worth asserting
// directly rather than only indirectly through five separate signal tests.
test('projectHealthService.scale: linear between badAt and goodAt, clamped outside it', () => {
  assert.strictEqual(projectHealthScale(90, 90, 14, 20), 0, 'at or below badAt scores zero');
  assert.strictEqual(projectHealthScale(200, 90, 14, 20), 0, 'worse than badAt still floors at zero, never negative');
  assert.strictEqual(projectHealthScale(14, 90, 14, 20), 20, 'at or above goodAt scores full marks');
  assert.strictEqual(projectHealthScale(0, 90, 14, 20), 20, 'better than goodAt still caps at full marks');
  assert.strictEqual(projectHealthScale(52, 90, 14, 20), 10, 'halfway between badAt and goodAt scores half marks');
});

test('projectHealthService.scale: also works with badAt > goodAt (fewer complaints = more points)', () => {
  assert.strictEqual(projectHealthScale(0, 5, 0, 20), 20, 'zero complaints scores full marks');
  assert.strictEqual(projectHealthScale(5, 5, 0, 20), 0, 'five complaints (badAt) scores zero');
  assert.strictEqual(projectHealthScale(10, 5, 0, 20), 0, 'worse than badAt still floors at zero');
});

test('projectHealth thresholds: warning (60) is stricter than critical (40) — a project cannot be critical without also being a warning', () => {
  assert.ok(CRITICAL_THRESHOLD < WARNING_THRESHOLD);
});

test('contractors.manage is owner-only', () => {
  assert.ok(canAccess('owner', 'contractors.manage'));
  assert.strictEqual(canAccess('sales_director', 'contractors.manage'), false);
  assert.strictEqual(canAccess('collections', 'contractors.manage'), false);
});

test('handover.manage is owner/sales_director only', () => {
  assert.ok(canAccess('owner', 'handover.manage'));
  assert.ok(canAccess('sales_director', 'handover.manage'));
  assert.strictEqual(canAccess('sales_rep', 'handover.manage'), false);
  assert.strictEqual(canAccess('collections', 'handover.manage'), false);
  assert.strictEqual(canAccess('documentation', 'handover.manage'), false);
});

test('financing.manage is owner-only; financing.read is owner/sales_director', () => {
  assert.ok(canAccess('owner', 'financing.manage'));
  assert.strictEqual(canAccess('sales_director', 'financing.manage'), false);

  assert.ok(canAccess('owner', 'financing.read'));
  assert.ok(canAccess('sales_director', 'financing.read'));
  assert.strictEqual(canAccess('sales_rep', 'financing.read'), false);
});

// SECTION 8 — opening/editing a legal case is owner-only (same weight as
// waiving debt); a director may still READ where every case stands.
test('legal.manage is owner-only; legal.read is owner/sales_director', () => {
  assert.ok(canAccess('owner', 'legal.manage'));
  assert.strictEqual(canAccess('sales_director', 'legal.manage'), false);
  assert.strictEqual(canAccess('collections', 'legal.manage'), false);

  assert.ok(canAccess('owner', 'legal.read'));
  assert.ok(canAccess('sales_director', 'legal.read'));
  assert.strictEqual(canAccess('sales_rep', 'legal.read'), false);
  assert.strictEqual(canAccess('collections', 'legal.read'), false);
  assert.strictEqual(canAccess('documentation', 'legal.read'), false);
});

test('hardship.review is owner/sales_director only', () => {
  assert.ok(canAccess('owner', 'hardship.review'));
  assert.ok(canAccess('sales_director', 'hardship.review'));
  assert.strictEqual(canAccess('sales_rep', 'hardship.review'), false);
  assert.strictEqual(canAccess('collections', 'hardship.review'), false);
  assert.strictEqual(canAccess('documentation', 'hardship.review'), false);
});

// SECTION 5 — the buyer message thread is a sales channel, not a
// collections or paperwork one.
test('messages.read/write are owner/sales_director/sales_rep, not collections or documentation', () => {
  for (const action of ['messages.read', 'messages.write']) {
    assert.ok(canAccess('owner', action));
    assert.ok(canAccess('sales_director', action));
    assert.ok(canAccess('sales_rep', action));
    assert.strictEqual(canAccess('collections', action), false);
    assert.strictEqual(canAccess('documentation', action), false);
  }
});

test('activities.write is everyone except documentation', () => {
  assert.ok(canAccess('owner', 'activities.write'));
  assert.ok(canAccess('sales_director', 'activities.write'));
  assert.ok(canAccess('sales_rep', 'activities.write'));
  assert.ok(canAccess('collections', 'activities.write'));
  assert.strictEqual(canAccess('documentation', 'activities.write'), false);
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

// ── Role-change guards (self-demotion / downgrade confirmation) ─────────
test('isDowngrade: owner→director and director→operational are downgrades', () => {
  assert.ok(isDowngrade('owner', 'sales_director'));
  assert.ok(isDowngrade('owner', 'sales_rep'));
  assert.ok(isDowngrade('sales_director', 'sales_rep'));
  assert.ok(isDowngrade('sales_director', 'collections'));
  assert.ok(isDowngrade('sales_director', 'documentation'));
});

test('isDowngrade: promotions and lateral moves between operational roles are not downgrades', () => {
  assert.strictEqual(isDowngrade('sales_rep', 'sales_director'), false);
  assert.strictEqual(isDowngrade('sales_director', 'owner'), false);
  // sales_rep, collections and documentation are peers — moving between them
  // is a different job, not a step down either way.
  assert.strictEqual(isDowngrade('sales_rep', 'collections'), false);
  assert.strictEqual(isDowngrade('collections', 'documentation'), false);
  assert.strictEqual(isDowngrade('documentation', 'sales_rep'), false);
  assert.strictEqual(isDowngrade('owner', 'owner'), false);
});

test('capabilitiesLostGoingFrom: owner→sales_director loses only owner-exclusive actions', () => {
  const lost = capabilitiesLostGoingFrom('owner', 'sales_director');
  assert.strictEqual(lost.length, 1);
  assert.match(lost[0], /owner-only actions/);
});

test('capabilitiesLostGoingFrom: sales_director→sales_rep keeps selling, loses money-in and paperwork', () => {
  const lost = capabilitiesLostGoingFrom('sales_director', 'sales_rep');
  assert.ok(lost.some((l) => /director-level access/.test(l)));
  assert.ok(lost.some((l) => /recording payments/.test(l)));
  assert.ok(lost.some((l) => /generating, updating and downloading documents/.test(l)));
  // sales_rep keeps SELLERS access, so that group must not appear as lost.
  assert.ok(!lost.some((l) => /creating buyers and reservations/.test(l)));
});

test('capabilitiesLostGoingFrom: sales_director→collections keeps money-in, loses paperwork and selling', () => {
  const lost = capabilitiesLostGoingFrom('sales_director', 'collections');
  assert.ok(!lost.some((l) => /recording payments/.test(l)), 'collections keeps money-in access');
  assert.ok(lost.some((l) => /generating, updating and downloading documents/.test(l)));
  assert.ok(lost.some((l) => /creating buyers and reservations/.test(l)));
});

test('capabilitiesLostGoingFrom: a lateral move between operational roles is not empty either way it is asked', () => {
  // Confirms the function itself is accurate even when isDowngrade() (the
  // thing that decides whether to call it at all) would say "not a
  // downgrade" — sales_rep and collections really do have different,
  // non-overlapping capabilities, which is the whole reason neither ranks
  // above the other.
  assert.ok(capabilitiesLostGoingFrom('sales_rep', 'collections').some((l) => /creating buyers and reservations/.test(l)));
  assert.ok(capabilitiesLostGoingFrom('collections', 'sales_rep').some((l) => /recording payments/.test(l)));
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

// SECTION 4 — hardshipService.requestPause's input validation. Both bad-input
// cases throw before the function ever touches supabaseAdmin (see the file's
// own source — the length/range checks run first), so a fake customer object
// is enough; no database stub required, unlike runBrandingTests above.
async function runHardshipValidationTests() {
  section('Hardship mode — request validation');

  const fakeCustomer = { id: 'cust-1', organization_id: 'org-1', full_name: 'Buyer', email: null };

  await testAsync('a reason under 20 characters is refused before any database read', async () => {
    await assert.rejects(
      () => requestPause(fakeCustomer, 'res-1', { reason: 'too short', pauseMonths: 1 }),
      /at least 20 characters/
    );
  });

  await testAsync('pause_months outside 1-3 is refused', async () => {
    await assert.rejects(
      () => requestPause(fakeCustomer, 'res-1', { reason: 'Lost my job and need time to recover', pauseMonths: 4 }),
      /between 1 and 3/
    );
    await assert.rejects(
      () => requestPause(fakeCustomer, 'res-1', { reason: 'Lost my job and need time to recover', pauseMonths: 0 }),
      /between 1 and 3/
    );
  });
}

// SECTION 10 — the exchange-rate cache. Seeding a FRESH cache via
// _setCacheForTests means getRates() takes its cache-hit path and never
// calls the real ExchangeRate-API — deterministic and offline, the same
// reasoning every other suite in this file relies on.
async function runExchangeRateTests() {
  section('Exchange rates — display cache (SECTION 10)');

  await testAsync('a fresh cache is served as-is, filtered to the four display currencies, and marked not stale', async () => {
    exchangeRateService._setCacheForTests({
      rates: { USD: 0.0006, GBP: 0.00048, EUR: 0.00055, CAD: 0.00082, JPY: 0.09 },
      fetched_at: Date.now(),
    });
    const result = await exchangeRateService.getRates();
    assert.strictEqual(result.base, 'NGN');
    assert.deepStrictEqual(Object.keys(result.rates).sort(), ['CAD', 'EUR', 'GBP', 'USD']);
    assert.strictEqual(result.stale, false);
  });

  await testAsync('a refresh failure falls back to the stale cache rather than throwing or returning nothing', async () => {
    exchangeRateService._setCacheForTests({
      rates: { USD: 0.0006, GBP: 0.00048 },
      fetched_at: Date.now() - (exchangeRateService.CACHE_TTL_MS + 60_000),
    });
    // Swapped for the duration of this one call and restored after, the same
    // pattern every withFake* helper in this file uses for supabaseAdmin.from
    // — this suite stays offline even though getRates() would otherwise hit
    // the real ExchangeRate-API once the cache is stale.
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('network unreachable in test'); };
    try {
      const result = await exchangeRateService.getRates();
      assert.ok(result.rates, 'falls back to the stale cache rather than returning nothing');
      assert.strictEqual(result.rates.USD, 0.0006);
    } finally {
      global.fetch = originalFetch;
    }
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

// ── errorHandler — headers-sent guard, no-reflection messages, code fallback
// (src/middleware/errorHandler.js). Pure middleware functions taking plain
// req/res objects — no Express app or network needed to exercise them.
section('errorHandler — headersSent guard, no-reflection messages, SQLSTATE fallback');
{
  const { errorHandler, notFound } = require('../middleware/errorHandler');

  test('errorHandler defers to next(err) instead of writing a second response once headers are sent', () => {
    // reports.js's CSV export streams headers before the body; if a later
    // error reaches errorHandler in that state, res.status().json() throws
    // ERR_HTTP_HEADERS_SENT. res below throws if either is called at all, so
    // this fails loudly if the guard regresses.
    const res = {
      headersSent: true,
      status() { throw new Error('must not call res.status() once headers are sent'); },
      json() { throw new Error('must not call res.json() once headers are sent'); },
    };
    const req = { method: 'GET', originalUrl: '/api/re/reports/collections.csv' };
    const err = new Error('boom mid-stream');
    let nextArg = 'not called';
    errorHandler(err, req, res, (passed) => { nextArg = passed; });
    assert.strictEqual(nextArg, err);
  });

  test('errorHandler logs a SQLSTATE fallback (and never .hint/.details) for a plain supabase-js error with no .stack', () => {
    const logs = [];
    const original = console.error;
    console.error = (...args) => logs.push(args.join(' '));
    try {
      const res = { headersSent: false, status() { return this; }, json() {} };
      const req = { method: 'POST', originalUrl: '/api/re/units' };
      // supabase-js throws a plain {message, details, hint, code} object, not
      // an Error — no .stack. .details/.hint can quote an offending row's
      // actual values (CLAUDE.md's "Data retention" section), so only
      // .message and the SQLSTATE .code may ever reach the log.
      const dbErr = {
        message: 'duplicate key value violates unique constraint',
        code: '23505',
        details: 'Key (unit_number)=(A101) already exists.',
        hint: 'row-data-must-not-be-logged',
      };
      errorHandler(dbErr, req, res, () => {});
    } finally {
      console.error = original;
    }
    const joined = logs.join('\n');
    assert.ok(joined.includes('code=23505'), `expected a SQLSTATE fallback in the log, got: ${joined}`);
    assert.ok(!joined.includes('row-data-must-not-be-logged'), 'err.hint must never be logged');
    assert.ok(!joined.includes('unit_number'), 'err.details must never be logged');
  });

  test('notFound returns a constant message and does not reflect req.originalUrl into the response', () => {
    let statusCode = null;
    let body = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; },
    };
    const req = { method: 'GET', originalUrl: '/api/re/"><script>alert(1)</script>' };
    notFound(req, res);
    assert.strictEqual(statusCode, 404);
    assert.strictEqual(body.error, 'Not found.');
    assert.ok(!body.error.includes('<script>'), 'notFound must not reflect the request URL back to the caller');
  });
}

// ── RBAC — sales_rep gains read-only payment status + document download ──
// (src/services/permissions.js). This file's own role description for
// sales_rep says "sees payment status, cannot record payment" — until this
// fix, payments.read/payments.schedule granted NEITHER, contradicting it.
// documents.download similarly excluded sales_rep even though
// documents.create/read already included them ("can request, cannot issue").
section('RBAC — sales_rep read-only payments + document download (permissions.js)');

test('sales_rep can now read payment status and the schedule, but still cannot record a payment', () => {
  assert.strictEqual(canAccess('sales_rep', 'payments.read'), true);
  assert.strictEqual(canAccess('sales_rep', 'payments.schedule'), true);
  assert.strictEqual(canAccess('sales_rep', 'payments.record'), false);
  assert.strictEqual(canAccess('sales_rep', 'payments.init'), false);
  assert.strictEqual(canAccess('sales_rep', 'payments.reallocate'), false);
});

test('sales_rep can now download a document they requested, but still cannot generate one', () => {
  assert.strictEqual(canAccess('sales_rep', 'documents.download'), true);
  assert.strictEqual(canAccess('sales_rep', 'documents.generate'), false);
  assert.strictEqual(canAccess('sales_rep', 'documents.updateStatus'), false);
});

test('collections and documentation are unaffected by the sales_rep additions above', () => {
  // The fix widened two grants by exactly one role each — confirms nothing
  // else in the matrix moved as a side effect.
  assert.strictEqual(canAccess('collections', 'payments.read'), true); // was already MONEY_IN
  assert.strictEqual(canAccess('collections', 'documents.download'), false); // never granted
  assert.strictEqual(canAccess('documentation', 'payments.read'), false);
});

// actionsFor/canAccess must still agree after this change — the existing
// "actionsFor(role) agrees with canAccess for every action" test above
// already re-runs against the live PERMISSIONS object, so a second explicit
// check here would be redundant; this section instead checks the two
// specific grants the fix touched, which that generic loop does not name.

// ── stripFinancials — commission_rate is now stripped (routes/reservations.js) ──
// migrations/020 added commission_rate to re_reservations; select('*') in
// GET /reservations returns it to documentation same as list_price/
// total_amount unless the strip covers it too.
section('stripFinancials strips commission_rate (routes/reservations.js)');

test('nulls list_price, plan total_amount AND commission_rate — a documentation officer sees no naira figure and no percentage', () => {
  const reservation = {
    id: 'res-1',
    commission_rate: 5,
    re_units: { unit_number: 'B12', list_price: 45_000_000 },
    re_installment_plans: [{ id: 'plan-1', total_amount: 45_000_000 }],
  };
  reservationsRouter.stripFinancials(reservation);
  assert.strictEqual(reservation.commission_rate, null);
  assert.strictEqual(reservation.re_units.list_price, null);
  assert.strictEqual(reservation.re_installment_plans[0].total_amount, null);
});

test('stripFinancials handles a reservation with no plan yet without throwing', () => {
  const reservation = { id: 'res-2', commission_rate: 3.5, re_units: null, re_installment_plans: [] };
  assert.doesNotThrow(() => reservationsRouter.stripFinancials(reservation));
  assert.strictEqual(reservation.commission_rate, null);
});

// ── Audit financial content gate (routes/audit.js) ────────────────────────
// audit.readEntity is granted to every role including documentation
// (permissions.js), and GET /entity/:type/:id otherwise returned raw
// summary/metadata with no gate — the same class of leak customers.js/
// units.js/reservations.js already guard against on their own direct views.
section('Audit entity route — financial content gate (routes/audit.js)');

const sampleAuditRows = [
  { id: 'a1', entity_type: 're_payments', summary: '₦500,000 payment voided — wrong amount', metadata: { amount: 500000 } },
  { id: 'a2', entity_type: 're_commissions', summary: 'Commission of ₦93,750 marked paid', metadata: { amount: 93750 } },
  { id: 'a3', entity_type: 're_units', summary: 'List price changed to ₦46,000,000', metadata: { list_price: 46000000 } },
  { id: 'a4', entity_type: 're_reservations', summary: 'Reservation moved from reserved to confirmed', metadata: { from: 'reserved', to: 'confirmed' } },
];

test('redactFinancialAuditRows strips summary/metadata on financial entity types when the caller lacks financial.view', () => {
  const redacted = auditRouter.redactFinancialAuditRows(sampleAuditRows, false);
  const payment = redacted.find((r) => r.id === 'a1');
  const commission = redacted.find((r) => r.id === 'a2');
  const unit = redacted.find((r) => r.id === 'a3');
  assert.strictEqual(payment.summary, null);
  assert.deepStrictEqual(payment.metadata, {});
  assert.strictEqual(commission.summary, null);
  assert.strictEqual(unit.summary, null, 'a unit price change is a financial fact too — re_units is in FINANCIAL_ENTITY_TYPES');
});

test('redactFinancialAuditRows leaves a non-financial entity type untouched even without financial.view', () => {
  const redacted = auditRouter.redactFinancialAuditRows(sampleAuditRows, false);
  const reservationStatus = redacted.find((r) => r.id === 'a4');
  assert.strictEqual(reservationStatus.summary, 'Reservation moved from reserved to confirmed');
  assert.deepStrictEqual(reservationStatus.metadata, { from: 'reserved', to: 'confirmed' });
});

test('redactFinancialAuditRows returns every row unchanged when the caller HAS financial.view', () => {
  const redacted = auditRouter.redactFinancialAuditRows(sampleAuditRows, true);
  assert.strictEqual(redacted, sampleAuditRows, 'must be the exact same array — no copying/filtering when the caller may see money');
});

test('FINANCIAL_ENTITY_TYPES names exactly the money-carrying entity types the fix describes', () => {
  for (const t of ['re_payments', 're_commissions', 're_installment_schedule', 're_units', 're_installment_plans']) {
    assert.ok(auditRouter.FINANCIAL_ENTITY_TYPES.has(t), `expected ${t} to be gated`);
  }
  assert.ok(!auditRouter.FINANCIAL_ENTITY_TYPES.has('re_reservations'), 'a status change alone is not financial');
  assert.ok(!auditRouter.FINANCIAL_ENTITY_TYPES.has('re_customers'));
});

// ── Reporting features (routes/reports.js) — leaderboard date-range, custom
// report field selection, and payment-heatmap day-of-month bucketing. Every
// one of these is pure by design specifically so it is assertable here, the
// same reasoning the rest of this file's "pure core, thin Express wrapper"
// pattern already follows.
section('Reporting features (routes/reports.js)');

test('periodRange: this_month starts on the 1st of the current month, open-ended', () => {
  assert.deepStrictEqual(reportsRouter.periodRange('this_month', '2026-08-16'), { from: '2026-08-01', to: null });
});

test('periodRange: last_3_months spans this month plus the two before it', () => {
  // Aug + Jul + Jun = 3 months, so "from" lands on 1 Jun, not 1 May.
  assert.deepStrictEqual(reportsRouter.periodRange('last_3_months', '2026-08-16'), { from: '2026-06-01', to: null });
});

test('periodRange: last_3_months crosses a year boundary correctly', () => {
  assert.deepStrictEqual(reportsRouter.periodRange('last_3_months', '2026-01-16'), { from: '2025-11-01', to: null });
});

test('periodRange: this_year starts 1 January of the current year', () => {
  assert.deepStrictEqual(reportsRouter.periodRange('this_year', '2026-08-16'), { from: '2026-01-01', to: null });
});

test('periodRange: all_time, and anything unrecognised, applies no filter at all', () => {
  assert.deepStrictEqual(reportsRouter.periodRange('all_time', '2026-08-16'), { from: null, to: null });
  assert.deepStrictEqual(reportsRouter.periodRange('nonsense', '2026-08-16'), { from: null, to: null });
});

test('buildCustomReportColumns: keeps only real field ids, in the order the caller asked for', () => {
  const columns = reportsRouter.buildCustomReportColumns('phone,buyer_name,not_a_real_field');
  assert.strictEqual(columns.length, 2);
  assert.strictEqual(columns[0][0], 'Phone', 'phone was listed first by the caller, so it comes first in the CSV');
  assert.strictEqual(columns[1][0], 'Buyer name');
});

test('buildCustomReportColumns: an empty or all-invalid fields param yields zero columns', () => {
  assert.strictEqual(reportsRouter.buildCustomReportColumns('').length, 0);
  assert.strictEqual(reportsRouter.buildCustomReportColumns('made_up,also_fake').length, 0);
});

test('CUSTOM_REPORT_FIELDS names exactly the sixteen fields the spec lists, no more, no fewer', () => {
  const expected = [
    'buyer_name', 'email', 'phone', 'unit_number', 'project_name', 'total_contracted',
    'total_paid', 'balance', 'overdue_amount', 'credit_score', 'sales_rep_name',
    'reservation_date', 'last_payment_date', 'next_due_date', 'escalation_stage', 'referral_code',
  ];
  assert.deepStrictEqual(Object.keys(reportsRouter.CUSTOM_REPORT_FIELDS).sort(), expected.sort());
});

test('bucketPaymentsByDayOfMonth: sums amounts and counts onto the day-of-month a payment landed on, across different months', () => {
  const days = reportsRouter.bucketPaymentsByDayOfMonth([
    { amount: 100000, paid_at: '2026-01-15T10:00:00Z' },
    { amount: 50000, paid_at: '2026-03-15T10:00:00Z' }, // same day-of-month, different month — must add, not overwrite
    { amount: 20000, paid_at: '2026-02-01T10:00:00Z' },
  ]);
  assert.strictEqual(days.length, 31);
  assert.strictEqual(days[14].day, 15);
  assert.strictEqual(days[14].amount, 150000);
  assert.strictEqual(days[14].count, 2);
  assert.strictEqual(days[0].amount, 20000);
  assert.strictEqual(days[0].count, 1);
  assert.strictEqual(days[1].amount, 0, 'a day nothing was ever collected on stays at zero, not missing');
});

test('bucketPaymentsByDayOfMonth: a payment with no paid_at is silently skipped, not a NaN bucket', () => {
  const days = reportsRouter.bucketPaymentsByDayOfMonth([{ amount: 100000, paid_at: null }]);
  assert.ok(days.every((d) => d.amount === 0 && d.count === 0));
});

test('reports.leaderboard/customExport/heatmap and audit.export match the permission tiers the feature calls for', () => {
  // DIRECTORS — same tier as reports.collections/reports.rental beside them.
  for (const action of ['reports.leaderboard', 'reports.customExport', 'reports.heatmap']) {
    assert.ok(canAccess('owner', action));
    assert.ok(canAccess('sales_director', action));
    assert.strictEqual(canAccess('sales_rep', action), false);
    assert.strictEqual(canAccess('collections', action), false);
  }
  // audit.export is narrower than audit.read — owner only.
  assert.ok(canAccess('owner', 'audit.export'));
  assert.strictEqual(canAccess('sales_director', 'audit.export'), false);
});

// SECTION 7 — buyer blacklist. Owner only, same weight as waiving debt or
// deleting a record (permissions.js's own reasoning for customers.blacklist).
test('customers.blacklist is owner-only', () => {
  assert.ok(canAccess('owner', 'customers.blacklist'));
  assert.strictEqual(canAccess('sales_director', 'customers.blacklist'), false);
  assert.strictEqual(canAccess('sales_rep', 'customers.blacklist'), false);
});

// SECTION 4 — bulk portal-link send is narrower than the single-buyer send:
// owner + sales director only, where customers.portalAccess also reaches a
// sales rep and collections.
test('customers.bulkPortalLink is narrower than the single-buyer customers.portalAccess', () => {
  assert.ok(canAccess('owner', 'customers.bulkPortalLink'));
  assert.ok(canAccess('sales_director', 'customers.bulkPortalLink'));
  assert.strictEqual(canAccess('sales_rep', 'customers.bulkPortalLink'), false);
  assert.strictEqual(canAccess('collections', 'customers.bulkPortalLink'), false);
  // The single-buyer send DOES reach a sales rep and collections — the two
  // permissions are deliberately different widths, not the same rule twice.
  assert.ok(canAccess('sales_rep', 'customers.portalAccess'));
  assert.ok(canAccess('collections', 'customers.portalAccess'));
});

// SECTION 8 — bulk document generation. Owner + documentation officer only —
// narrower than documents.generate (PAPERWORK, which also includes
// sales_director) since no existing group constant is exactly that pair.
test('documents.bulkGenerate is owner + documentation only, narrower than documents.generate', () => {
  assert.ok(canAccess('owner', 'documents.bulkGenerate'));
  assert.ok(canAccess('documentation', 'documents.bulkGenerate'));
  assert.strictEqual(canAccess('sales_director', 'documents.bulkGenerate'), false);
  assert.strictEqual(canAccess('sales_rep', 'documents.bulkGenerate'), false);
  // documents.generate DOES reach sales_director.
  assert.ok(canAccess('sales_director', 'documents.generate'));
});

// SECTION 14 — customizable email content (notificationService.js).
section('Email template variable substitution (notificationService.js)');

test('substituteTemplateVariables: replaces every known {{var}} token', () => {
  const result = substituteTemplateVariables(
    'Hi {{buyer_name}}, you paid {{amount}} for {{unit}}.',
    { buyer_name: 'Mrs Adeyemi', amount: '₦500,000', unit: 'Unit 4B' }
  );
  assert.strictEqual(result, 'Hi Mrs Adeyemi, you paid ₦500,000 for Unit 4B.');
});

test('substituteTemplateVariables: an unknown {{token}} is left exactly as written, not blanked', () => {
  const result = substituteTemplateVariables('Hi {{buyer_name}}, {{not_a_real_var}}.', { buyer_name: 'Tunde' });
  assert.strictEqual(result, 'Hi Tunde, {{not_a_real_var}}.');
});

test('substituteTemplateVariables: escapes HTML-significant characters by default (body_html context)', () => {
  const result = substituteTemplateVariables('<p>{{buyer_name}}</p>', { buyer_name: "O'Brien & Co <script>" });
  assert.strictEqual(result, '<p>O&#x27;Brien &amp; Co &lt;script&gt;</p>');
});

test('substituteTemplateVariables: escape:false leaves the value raw (subject-line context)', () => {
  const result = substituteTemplateVariables('Receipt for {{buyer_name}}', { buyer_name: "O'Brien & Co" }, { escape: false });
  assert.strictEqual(result, "Receipt for O'Brien & Co");
});

test('EMAIL_TEMPLATE_TYPES names exactly the five types the spec lists', () => {
  assert.deepStrictEqual(EMAIL_TEMPLATE_TYPES.slice().sort(),
    ['document_ready', 'overdue_reminder', 'portal_link', 'receipt', 'welcome'].sort());
});

// ── Input validation — UUID shape + numeric clamps (audit.js, reports.js, ──
// customers.js, dashboard.js) — a negative/zero limit or a malformed id
// query param used to reach Postgres unshaped and surface as an opaque 500.
section('Input validation — UUID shape + numeric floor/ceiling clamps');

test('UUID_RE (audit.js — identical pattern in reports.js/dashboard.js) accepts a real uuid and rejects junk', () => {
  assert.ok(auditRouter.UUID_RE.test('9f8b7c6d-1234-4a5b-8c9d-0e1f2a3b4c5d'));
  assert.ok(auditRouter.UUID_RE.test('AA11BB22-CC33-4D44-8E55-FF66AA77BB88'), 'case-insensitive');
  assert.strictEqual(auditRouter.UUID_RE.test('not-a-uuid'), false);
  assert.strictEqual(auditRouter.UUID_RE.test('9f8b7c6d-1234-4a5b-8c9d'), false, 'too short');
  assert.strictEqual(auditRouter.UUID_RE.test("'; drop table re_payments; --"), false);
  assert.strictEqual(auditRouter.UUID_RE.test(''), false);
});

test('the floor+ceiling clamp formula used across these routes rejects negative/zero and still caps a huge value', () => {
  // Math.max(1, Math.min(Number(query.limit) || DEFAULT, CAP)) — the exact
  // shape every fixed route now uses. Exercised generically here since the
  // constant lives inline in four different route files, not as one shared
  // exported helper.
  const clamp = (raw, fallback, cap) => Math.max(1, Math.min(Number(raw) || fallback, cap));
  assert.strictEqual(clamp('-5', 100, 500), 1, 'a negative limit must not reach Postgres as -5');
  // Number('0') || fallback evaluates to fallback — 0 is falsy in JS, so an
  // explicit ?limit=0 is treated the same as an absent one (falls back to
  // the default) rather than clamped up to 1. That is the actual behaviour
  // of the `||`-based formula used in every fixed route; the floor exists to
  // catch a NEGATIVE value slipping past the `||`, not zero.
  assert.strictEqual(clamp('0', 100, 500), 100);
  assert.strictEqual(clamp('50', 100, 500), 50);
  assert.strictEqual(clamp('999999', 100, 500), 500, 'still capped at the ceiling');
  assert.strictEqual(clamp(undefined, 100, 500), 100, 'falls back to the default when absent');
});

// ── Webhook permanent-failure classification (routes/webhooks.js) ────────
// A live Paystack webhook retry storm can't be simulated offline, so this
// exercises the one piece of the fix that is pure: which Postgres error
// codes are treated as permanent (ack with 200, stop the retry storm, flag
// for manual review) versus transient (keep returning 500 so Paystack
// retries, since those genuinely might succeed later).
section('Webhook permanent-failure classification (routes/webhooks.js)');

test('PERMANENT_PG_ERROR_CODES contains exactly the three documented SQLSTATEs', () => {
  const codes = webhooksRouter.PERMANENT_PG_ERROR_CODES;
  assert.ok(codes.has('23514'), 'check_violation');
  assert.ok(codes.has('23502'), 'not_null_violation');
  assert.ok(codes.has('22P02'), 'invalid_text_representation');
  assert.strictEqual(codes.size, 3);
});

test('a genuinely transient error code is NOT classified as permanent — Paystack must keep retrying it', () => {
  const codes = webhooksRouter.PERMANENT_PG_ERROR_CODES;
  assert.strictEqual(codes.has('57014'), false, 'query_canceled — a timeout, might succeed on retry');
  assert.strictEqual(codes.has('08006'), false, 'connection_failure — transient');
  assert.strictEqual(codes.has(undefined), false, 'an error with no .code at all must fall through to the 500 path');
});

// ── Import overpayment rounding (routes/imports.js) ───────────────────────
// The excess-money fix attaches whatever is left over after the backfill
// loop to the LAST payment row as `amount += remaining` / `overpayment =
// remaining`, rounded to the kobo exactly like every other money
// calculation in this codebase (toKobo/toNaira in paystackService.js). The
// arithmetic is inline in the route rather than an exported helper, so this
// exercises the identical formula against the float-drift case that makes
// kobo rounding matter in the first place.
section('Import overpayment rounding matches the kobo-rounding convention used everywhere else');

test('an excess that does not round cleanly in floating point still lands on exactly two decimal places', () => {
  const applyOverpayment = (lastAmount, remaining) => ({
    amount: Math.round((lastAmount + remaining) * 100) / 100,
    overpayment: Math.round(remaining * 100) / 100,
  });
  // 3_333_333.34 + 0.1 + 0.2 style drift.
  const result = applyOverpayment(3_333_333.34, 1000.1 + 2000.2 - 3000.3 + 500.005);
  // remaining ≈ 500.005 after the float-noisy arithmetic above; the point of
  // the test is that BOTH fields end up rounded to the kobo, not that this
  // specific remainder is meaningful.
  assert.strictEqual(Number(result.amount.toFixed(2)), result.amount);
  assert.strictEqual(Number(result.overpayment.toFixed(2)), result.overpayment);
});

test('the last payment row absorbs the full excess when a buyer pays more than the whole plan', () => {
  const applyOverpayment = (lastAmount, remaining) => ({
    amount: Math.round((lastAmount + remaining) * 100) / 100,
    overpayment: Math.round(remaining * 100) / 100,
  });
  // Last installment was ₦500,000 due; buyer's backfilled total left
  // ₦75,000 over after every row was covered.
  const result = applyOverpayment(500_000, 75_000);
  assert.strictEqual(result.amount, 575_000, 'the row\'s amount carries the full transferred sum, due + excess');
  assert.strictEqual(result.overpayment, 75_000);
});

// SECTION 14 — the offline sync queue's data structure (offline-queue.js).
// The IndexedDB-backed storage and the service worker's own caching are not
// testable here (no browser, no ServiceWorkerGlobalScope in Node) — these
// are the PURE functions that decide queue-entry shape, sync order and the
// topbar indicator's state, exactly the seam this file's own header points to.
section('Offline sync queue (SECTION 14)');

test('buildEntry produces a well-shaped, pending queue entry', () => {
  const entry = buildEntry('new_buyer', '/customers', { full_name: 'Mrs Adeyemi' });
  assert.strictEqual(entry.type, 'new_buyer');
  assert.strictEqual(entry.path, '/customers');
  assert.deepStrictEqual(entry.payload, { full_name: 'Mrs Adeyemi' });
  assert.strictEqual(entry.status, 'pending');
  assert.strictEqual(entry.attempts, 0);
  assert.strictEqual(entry.last_error, null);
  assert.ok(entry.id, 'has a unique id');
  assert.ok(!Number.isNaN(Date.parse(entry.queued_at)), 'queued_at is a real timestamp');
});

test('buildEntry gives two entries built back-to-back different ids', () => {
  const a = buildEntry('log_activity', '/customers/1/activities', { notes: 'x' });
  const b = buildEntry('log_activity', '/customers/1/activities', { notes: 'y' });
  assert.notStrictEqual(a.id, b.id);
});

test('sortByQueuedAt orders oldest first — "sync all queued submissions in order"', () => {
  const first = { id: 'a', queued_at: '2026-01-01T09:00:00.000Z' };
  const second = { id: 'b', queued_at: '2026-01-01T09:05:00.000Z' };
  const third = { id: 'c', queued_at: '2026-01-01T09:10:00.000Z' };
  const sorted = sortByQueuedAt([third, first, second]);
  assert.deepStrictEqual(sorted.map((e) => e.id), ['a', 'b', 'c']);
});

test('sortByQueuedAt does not mutate the array it was given', () => {
  const original = [{ id: 'b', queued_at: '2026-01-01T09:05:00.000Z' }, { id: 'a', queued_at: '2026-01-01T09:00:00.000Z' }];
  const originalOrder = original.map((e) => e.id);
  sortByQueuedAt(original);
  assert.deepStrictEqual(original.map((e) => e.id), originalOrder);
});

test('summarize: an empty queue reads as synced', () => {
  const summary = summarize([]);
  assert.strictEqual(summary.isSynced, true);
  assert.strictEqual(summary.isSyncing, false);
  assert.strictEqual(summary.pendingCount, 0);
  assert.strictEqual(summary.failedCount, 0);
});

test('summarize: a mix of pending/syncing/failed counts each correctly, for the topbar indicator', () => {
  const summary = summarize([
    { status: 'pending' }, { status: 'pending' }, { status: 'syncing' }, { status: 'failed' },
  ]);
  assert.strictEqual(summary.total, 4);
  assert.strictEqual(summary.pendingCount, 2);
  assert.strictEqual(summary.syncingCount, 1);
  assert.strictEqual(summary.failedCount, 1);
  assert.strictEqual(summary.isSyncing, true, 'any item mid-sync means the badge reads "Syncing"');
  assert.strictEqual(summary.isSynced, false, 'a non-empty queue is never "Synced", even if every item already failed once');
});

(async () => {
  // Each of these swaps supabaseAdmin.from for the duration of its own
  // suite and restores it afterward (see each function's own withFake*
  // helper) — run sequentially, never concurrently, or one suite's stub
  // would clobber another's mid-flight.
  await runPaystackWebhookOrgTests();
  await runPortalBalanceTests();
  await runAuthServiceTests();
  await runAuthMiddlewareTests();
  await runBrandingTests();
  await runHardshipValidationTests();
  await runExchangeRateTests();

  // ── Report ─────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  ${f.name}\n    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
    process.exit(1);
  }
})();
