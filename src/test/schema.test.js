// schema.test.js — runs migrations/ against a real Postgres and asserts the
// result is what the application code expects.
//
//     npm run test:schema
//
// PGlite is Postgres compiled to WASM, so this is the actual database engine
// rather than a parser: constraints fire, triggers run, RLS is real. No
// container, no connection string, nothing to clean up.
//
// Migrations are applied TWICE, because re-running them must be safe — that is
// the promise made at the top of 001.
//
// The behavioural checks at the bottom matter most. Every column asserted here
// is one the application SELECTs by name, and a missing one is not a blank
// field but a failed query and a 500.
const fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');

const M = require('path').join(__dirname, '../../migrations');
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
}

(async () => {
  const db = new PGlite();

  // ── Apply migrations, twice, to prove idempotency ───────────────────────
  for (const pass of ['first', 'second']) {
    for (const file of ['001_phase1_schema.sql', '002_ai_briefs.sql']) {
      const sql = fs.readFileSync(`${M}/${file}`, 'utf8');
      try {
        await db.exec(sql);
        console.log(`  ok   ${file} applied (${pass} run)`);
        passed++;
      } catch (err) {
        console.log(`  FAIL ${file} (${pass} run)\n       ${err.message}`);
        failures.push(`${file} ${pass}`);
        // A syntax error makes every later assertion meaningless.
        console.log(`\n${passed} passed, ${failures.length} failed`);
        process.exit(1);
      }
    }
  }

  const q = async (sql, params) => (await db.query(sql, params)).rows;

  // ── Tables exist ────────────────────────────────────────────────────────
  const tables = (await q(
    `select table_name from information_schema.tables where table_schema='public'`
  )).map((r) => r.table_name).sort();

  const expected = [
    'users', 'teams', 'team_members',
    're_projects', 're_units', 're_customers', 're_sales_reps', 're_reservations',
    're_installment_plans', 're_installment_schedule', 're_payments', 're_documents',
    're_tasks', 're_ai_briefs',
  ];
  for (const t of expected) {
    check(`table ${t} exists`, tables.includes(t), `have: ${tables.join(', ')}`);
  }

  // ── Every column the application actually SELECTs ───────────────────────
  const colsOf = async (t) =>
    (await q(`select column_name from information_schema.columns where table_name=$1`, [t]))
      .map((r) => r.column_name);

  // src/services/documentService.js resolveBranding()
  const userCols = await colsOf('users');
  const brandingCols = ['full_name', 'company_name', 'brand_company_name', 'brand_logo_url',
    'brand_address', 'brand_phone', 'brand_website'];
  check('users has every letterhead column documentService selects',
    brandingCols.every((c) => userCols.includes(c)),
    `missing: ${brandingCols.filter((c) => !userCols.includes(c)).join(', ')}`);

  // src/middleware/auth.js
  const memberCols = await colsOf('team_members');
  check('team_members has team_id, role, user_id, status (auth lookup)',
    ['team_id', 'role', 'user_id', 'status'].every((c) => memberCols.includes(c)),
    memberCols.join(', '));

  // src/services/documentService.js team branch
  const teamCols = await colsOf('teams');
  check('teams has name + owner_id', ['name', 'owner_id'].every((c) => teamCols.includes(c)), teamCols.join(', '));

  const briefCols = await colsOf('re_ai_briefs');
  check('re_ai_briefs has generated_by', briefCols.includes('generated_by'), briefCols.join(', '));

  const docCols = await colsOf('re_documents');
  check('re_documents has storage_path', docCols.includes('storage_path'), docCols.join(', '));

  // ── The two integrity locks ─────────────────────────────────────────────
  const indexes = (await q(`select indexname from pg_indexes where schemaname='public'`))
    .map((r) => r.indexname);
  check('double-allocation index exists', indexes.includes('uniq_re_active_reservation_per_unit'));
  check('paystack reference index exists', indexes.includes('uniq_re_payments_paystack_reference'));

  // ── RLS enabled everywhere, with no policies ────────────────────────────
  const rlsOff = (await q(
    `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' and c.relrowsecurity=false`
  )).map((r) => r.relname);
  check('RLS enabled on every table', rlsOff.length === 0, `without RLS: ${rlsOff.join(', ')}`);

  const policies = await q(`select policyname, tablename from pg_policies where schemaname='public'`);
  check('no permissive policies (deny-by-default)', policies.length === 0,
    policies.map((p) => `${p.tablename}.${p.policyname}`).join(', '));

  // ── Behaviour: the rules the schema is supposed to enforce ──────────────
  const [{ id: userId }] = await q(
    `insert into users (email, full_name) values ('dev@example.com','Dev') returning id`);
  check('can create a user (bootstrap block works)', Boolean(userId));

  const [{ id: projectId }] = await q(
    `insert into re_projects (organization_id, name) values ($1,'Test Estate') returning id`, [userId]);
  const [{ id: unitId }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price)
     values ($1,$2,'A1',45000000) returning id`, [userId, projectId]);
  const [{ id: customerId }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Buyer One') returning id`, [userId]);
  const [{ id: customer2 }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Buyer Two') returning id`, [userId]);

  await q(`insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3)`,
    [userId, unitId, customerId]);

  let doubleAllocationBlocked = false;
  try {
    await q(`insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3)`,
      [userId, unitId, customer2]);
  } catch (err) {
    doubleAllocationBlocked = /unique|duplicate/i.test(err.message);
  }
  check('database refuses a second live reservation on the same unit', doubleAllocationBlocked);

  // Cancelled reservations must not block re-selling the unit.
  await q(`update re_reservations set status='cancelled' where unit_id=$1`, [unitId]);
  let reReserved = true;
  try {
    await q(`insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3)`,
      [userId, unitId, customer2]);
  } catch (err) {
    reReserved = false;
    console.log(`       ${err.message}`);
  }
  check('a cancelled reservation frees the unit again', reReserved);

  // Webhook replay
  const [{ id: planId }] = await q(
    `insert into re_installment_plans (organization_id, reservation_id, total_amount, number_of_installments, start_date)
     select $1, id, 45000000, 12, '2026-01-01' from re_reservations where unit_id=$2 and status='reserved' limit 1
     returning id`, [userId, unitId]);
  const [{ id: schedId }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,1,'2026-01-01',3750000) returning id`, [userId, planId]);

  const ref = `REINST-${schedId}-1750000000000`;
  await q(`insert into re_payments (organization_id, schedule_id, amount, paystack_reference, method)
           values ($1,$2,3750000,$3,'paystack')`, [userId, schedId, ref]);

  let replayBlocked = false;
  try {
    await q(`insert into re_payments (organization_id, schedule_id, amount, paystack_reference, method)
             values ($1,$2,3750000,$3,'paystack')`, [userId, schedId, ref]);
  } catch (err) {
    replayBlocked = /unique|duplicate/i.test(err.message);
  }
  check('database refuses a replayed paystack reference', replayBlocked);

  // Two manual payments may legitimately share a null reference.
  let manualOk = true;
  try {
    await q(`insert into re_payments (organization_id, schedule_id, amount, method)
             values ($1,$2,100,'bank_transfer'), ($1,$2,200,'cash')`, [userId, schedId]);
  } catch (err) { manualOk = false; console.log(`       ${err.message}`); }
  check('manual payments are not caught by the paystack uniqueness rule', manualOk);

  // updated_at trigger
  const before = (await q(`select updated_at from users where id=$1`, [userId]))[0].updated_at;
  await new Promise((r) => setTimeout(r, 25));
  await q(`update users set full_name='Dev Renamed' where id=$1`, [userId]);
  const after = (await q(`select updated_at from users where id=$1`, [userId]))[0].updated_at;
  check('users.updated_at trigger fires', new Date(after) > new Date(before), `${before} → ${after}`);

  // Team path used by auth.js + documentService
  const [{ id: teamId }] = await q(
    `insert into teams (name, owner_id) values ('Test Co', $1) returning id`, [userId]);
  await q(`insert into team_members (team_id, user_id, role) values ($1,$2,'owner')`, [teamId, userId]);
  const member = await q(
    `select team_id, role from team_members where user_id=$1 and status='active'`, [userId]);
  check('auth team lookup returns an active membership', member.length === 1 && member[0].team_id === teamId);

  // Foreign keys the domain relies on
  let fkEnforced = false;
  try {
    await q(`insert into re_sales_reps (organization_id, user_id) values ($1,$2)`,
      [userId, '00000000-0000-4000-8000-000000000000']);
  } catch (err) { fkEnforced = /foreign key/i.test(err.message); }
  check('re_sales_reps.user_id is a real foreign key to users', fkEnforced);

  const [{ id: briefOrg }] = [{ id: userId }];
  await q(`insert into re_ai_briefs (organization_id, summary, payload, generated_by)
           values ($1,'s','{}'::jsonb,'fallback')`, [briefOrg]);
  let upsertOk = true;
  try {
    await q(`insert into re_ai_briefs (organization_id, summary, payload) values ($1,'s2','{}'::jsonb)
             on conflict (organization_id, brief_date) do update set summary=excluded.summary`, [briefOrg]);
  } catch (err) { upsertOk = false; console.log(`       ${err.message}`); }
  check('brief upsert target (organization_id, brief_date) exists', upsertOk);

  let badGeneratedBy = false;
  try {
    await q(`insert into re_ai_briefs (organization_id, brief_date, summary, payload, generated_by)
             values ($1,'2020-01-01','s','{}'::jsonb,'nonsense')`, [briefOrg]);
  } catch (err) { badGeneratedBy = /check/i.test(err.message); }
  check('generated_by is constrained to ai|fallback', badGeneratedBy);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err.message);
  process.exit(1);
});
