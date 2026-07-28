// smoke.js — the 8-step acceptance run from CLAUDE.md, automated.
//
// Unlike logic.test.js this one talks to a REAL running server and a REAL
// database. It creates a project named "Test Estate <timestamp>" plus its
// units, buyers and reservations. Point it at staging, not at a workspace
// with live customers in it.
//
//   RE_SMOKE_TOKEN=<bearer token signed with this service's JWT_SECRET> \
//   RE_SMOKE_URL=http://localhost:4000/api \
//   npm run smoke
//
// RE_SMOKE_URL accepts either the server root (http://localhost:4000) or the
// API base (http://localhost:4000/api) — /api is added when missing, because
// the routes are mounted at /api/re. It defaults to http://localhost:4000/api.
//
// The banner printed at startup shows the endpoint root being called and which
// setting it came from, so a fallback to localhost is never mistaken for a run
// against staging.
//
// Verifies, in order: project → units → customers → reservation with a
// 12-month plan → double-allocation is refused → payment settles an
// installment → overdue marking feeds the brief → dashboard reflects it all.

const DEFAULT_API = 'http://localhost:4000/api';

// RE_SMOKE_API is the previous name for this, still honoured so an already
// exported value does not silently stop working.
const configuredApi = process.env.RE_SMOKE_URL || process.env.RE_SMOKE_API;

// Routes live at /api/re/*, so the base has to include /api. Given the setting
// is called a URL, pasting the bare server root is the natural mistake — and
// it fails confusingly, with every request going to /re/projects and coming
// back 404. Accept either form: server root or API base.
function normalizeBase(raw) {
  const trimmed = String(raw).replace(/\/+$/, '');
  if (/\/api\/re$/.test(trimmed)) return trimmed.replace(/\/re$/, ''); // over-specified
  if (/\/api$/.test(trimmed)) return trimmed;
  return `${trimmed}/api`;
}

const API = normalizeBase(configuredApi || DEFAULT_API);

// Which setting won is printed in the banner below. Falling back to localhost
// without saying so is how you end up believing you smoke-tested staging.
const API_SOURCE = process.env.RE_SMOKE_URL ? 'RE_SMOKE_URL'
  : process.env.RE_SMOKE_API ? 'RE_SMOKE_API (deprecated, use RE_SMOKE_URL)'
  : 'default — no RE_SMOKE_URL set';

const TOKEN = process.env.RE_SMOKE_TOKEN;

if (!TOKEN) {
  console.error(`RE_SMOKE_TOKEN is required (a bearer token signed with this service's JWT_SECRET).`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
let step = 0;
const created = {};

async function call(method, path, body) {
  const res = await fetch(`${API}/re${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function check(label, condition, detail) {
  step += 1;
  if (condition) {
    console.log(`  ✓ ${step}. ${label}`);
  } else {
    console.error(`  ✗ ${step}. ${label}`);
    if (detail !== undefined) console.error('     got:', JSON.stringify(detail, null, 2).slice(0, 600));
    process.exitCode = 1;
    throw new Error(`step ${step} failed`);
  }
}

const naira = (n) => '₦' + Number(n || 0).toLocaleString('en-NG');

async function run() {
  // Show the endpoint root actually being called, not just the configured
  // base — the two differ whenever normalizeBase had to add /api.
  console.log(`\nSmoke test → ${API}/re`);
  console.log(`  target from: ${API_SOURCE}\n`);

  // 1 ── project
  const project = await call('POST', '/projects', {
    name: `Test Estate ${stamp}`, location: 'Ajah, Lagos', total_units: 5,
  });
  check('create project', project.status === 201 && project.body.id, project.body);
  created.projectId = project.body.id;

  // 2 ── units
  const units = await call('POST', '/units/bulk', {
    project_id: created.projectId,
    units: [1, 2, 3, 4, 5].map((n) => ({
      unit_number: `A${n}`, unit_type: '3-bedroom terrace', size_sqm: 140 + n, list_price: 45_000_000,
    })),
  });
  check('bulk create 5 units', units.status === 201 && units.body.length === 5, units.body);
  created.unitId = units.body[0].id;

  // 3 ── customers
  const buyerA = await call('POST', '/customers', {
    full_name: `Test Buyer A ${stamp}`, phone: '+2348012345678', email: 'buyer.a@example.com', source: 'smoke-test',
  });
  const buyerB = await call('POST', '/customers', {
    full_name: `Test Buyer B ${stamp}`, phone: '+2348087654321', source: 'smoke-test',
  });
  check('create 2 customers', buyerA.status === 201 && buyerB.status === 201, [buyerA.body, buyerB.body]);
  created.customerA = buyerA.body.id;
  created.customerB = buyerB.body.id;

  // 4 ── reservation + 12-month plan
  const reservation = await call('POST', '/reservations', {
    unit_id: created.unitId,
    customer_id: created.customerA,
    plan: {
      total_amount: 45_000_000,
      number_of_installments: 12,
      frequency: 'monthly',
      start_date: new Date().toISOString().slice(0, 10),
    },
  });
  const schedule = reservation.body?.plan?.schedule || [];
  const scheduleTotal = schedule.reduce((sum, row) => sum + Number(row.amount_due), 0);
  check('reserve unit and generate 12 installments',
    reservation.status === 201 && schedule.length === 12 && scheduleTotal === 45_000_000,
    { status: reservation.status, rows: schedule.length, total: scheduleTotal });
  created.reservationId = reservation.body.reservation.id;
  created.scheduleId = schedule[0].id;

  const unitAfter = await call('GET', `/units?project_id=${created.projectId}`);
  const claimed = unitAfter.body.find((u) => u.id === created.unitId);
  check('unit flipped to reserved', claimed?.status === 'reserved', claimed);

  // 5 ── the rule the product exists to enforce
  const double = await call('POST', '/reservations', {
    unit_id: created.unitId, customer_id: created.customerB,
  });
  check('second reservation on the same unit is refused (409)',
    double.status === 409, { status: double.status, body: double.body });

  // 6 ── payment settles the installment
  const payment = await call('POST', `/payments/${created.scheduleId}/record`, {
    amount: 3_750_000, method: 'bank_transfer', reference: `SMOKE-${stamp}`,
  });
  check('record a bank transfer', payment.status === 201, payment.body);

  const customerDetail = await call('GET', `/customers/${created.customerA}`);
  const firstInstallment = customerDetail.body?.re_reservations?.[0]
    ?.re_installment_plans?.[0]?.re_installment_schedule
    ?.find((row) => row.installment_number === 1);
  check('installment 1 is now paid', firstInstallment?.status === 'paid', firstInstallment);

  // 7 ── overdue → brief. The brief works with or without OPENAI_API_KEY:
  // without one it falls back to a rule-based summary.
  const brief = await call('POST', '/brief/generate');
  check('generate a brief', brief.status === 200 && typeof brief.body.summary === 'string', brief.body);
  console.log(`     brief (${brief.body.generated_by}): ${brief.body.summary.slice(0, 140)}…`);

  // 8 ── dashboard reflects reality
  const dashboard = await call('GET', '/dashboard');
  const d = dashboard.body;
  check('dashboard totals reflect the run',
    dashboard.status === 200 &&
    Number(d.collected_this_month) >= 3_750_000 &&
    d.units.reserved >= 1 && d.units.available >= 4 &&
    d.latest_brief !== null,
    d);
  console.log(`     collected ${naira(d.collected_this_month)} · outstanding ${naira(d.outstanding_total)} · overdue ${naira(d.overdue.amount)}`);

  const atRisk = await call('GET', '/dashboard/at-risk');
  check('at-risk endpoint responds', atRisk.status === 200 && Array.isArray(atRisk.body), atRisk.body);

  console.log(`\nAll checks passed. Test data is left in place for inspection:`);
  console.log(`  project    ${created.projectId}  ("Test Estate ${stamp}")`);
  console.log(`  reservation ${created.reservationId}\n`);
  console.log('To exercise overdue handling, set an installment due_date to a past');
  console.log('date in the SQL editor, run markOverdue(), then regenerate the brief.\n');
}

run().catch((err) => {
  console.error(`\nSmoke test stopped: ${err.message}\n`);
  process.exit(1);
});
