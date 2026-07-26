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
process.env.RE_DISABLE_CRON = 'true';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const { buildSchedule, addMonthsUTC } = require('../services/installmentService');
const { parseInstallmentReference, isRealEstateReference, buildReference } = require('../services/paystackService');
const { buildAllocationLetterHtml, describePaymentPlan } = require('../services/documentService');
const { buildFallbackBrief } = require('../services/aiBrief');
const { lagosToday } = require('../services/overdueService');

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
  assert.strictEqual(isRealEstateReference('flowdesk_sub_abc123'), false);
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

test('uses the Lagos day, not the host timezone day', () => {
  // 23:30 UTC is already tomorrow in Lagos (UTC+1). An installment due
  // "tomorrow" must not be marked overdue by a UTC-hosted cron.
  const utcDate = new Date('2026-07-26T23:30:00Z');
  assert.strictEqual(
    utcDate.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }),
    '2026-07-27'
  );
});

// ── Report ───────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ${f.name}\n    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
  process.exit(1);
}
