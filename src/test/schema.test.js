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
    for (const file of ['001_phase1_schema.sql', '002_ai_briefs.sql', '003_operations.sql']) {
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

  // ── Grants ──────────────────────────────────────────────────────────────
  // The runs above had no Supabase roles, so the grant block took its guarded
  // early exit. Create the roles and apply again to exercise the path that
  // actually runs in production — a missing grant does not fail the migration,
  // it fails every query later with "42501: permission denied".
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    end $$;
  `);

  for (const file of ['001_phase1_schema.sql', '002_ai_briefs.sql', '003_operations.sql']) {
    try {
      await db.exec(fs.readFileSync(`${M}/${file}`, 'utf8'));
      passed++;
      console.log(`  ok   ${file} applied with Supabase roles present`);
    } catch (err) {
      failures.push(`${file} grants`);
      console.log(`  FAIL ${file} with roles present\n       ${err.message}`);
    }
  }

  const granted = ['users', 'teams', 'team_members', 're_projects', 're_installment_schedule',
    're_payments', 're_documents', 're_tasks', 're_ai_briefs',
    're_org_settings', 're_commissions', 're_payment_promises', 're_audit_log', 're_notifications'];

  for (const t of granted) {
    const [{ ok }] = await q(
      `select has_table_privilege('service_role', $1, 'select')
          and has_table_privilege('service_role', $1, 'insert')
          and has_table_privilege('service_role', $1, 'update')
          and has_table_privilege('service_role', $1, 'delete') as ok`, [`public.${t}`]);
    check(`service_role can read and write ${t}`, ok);
  }

  const leaked = [];
  for (const t of granted) {
    for (const role of ['anon', 'authenticated']) {
      const [{ any }] = await q(
        `select has_table_privilege($2, $1, 'select')
             or has_table_privilege($2, $1, 'insert') as any`, [`public.${t}`, role]);
      if (any) leaked.push(`${role}→${t}`);
    }
  }
  check('anon and authenticated hold no privileges on any table', leaked.length === 0, leaked.join(', '));

  // ── Tables exist ────────────────────────────────────────────────────────
  const tables = (await q(
    `select table_name from information_schema.tables where table_schema='public'`
  )).map((r) => r.table_name).sort();

  const expected = [
    'users', 'teams', 'team_members',
    're_projects', 're_units', 're_customers', 're_sales_reps', 're_reservations',
    're_installment_plans', 're_installment_schedule', 're_payments', 're_documents',
    're_tasks', 're_ai_briefs',
    're_org_settings', 're_commissions', 're_payment_promises', 're_audit_log', 're_notifications',
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
  check('re_documents has payment_id (receipts)', docCols.includes('payment_id'), docCols.join(', '));

  // src/services/authService.js — this service now issues tokens as well as
  // verifying them, which means it stores a password verifier.
  const authCols = ['password_hash', 'google_sub', 'reset_token_hash', 'reset_token_expires_at',
    'last_login_at', 'avatar_url'];
  check('users has every credential column authService reads',
    authCols.every((c) => userCols.includes(c)),
    `missing: ${authCols.filter((c) => !userCols.includes(c)).join(', ')}`);

  const repCols = await colsOf('re_sales_reps');
  check('re_sales_reps has commission_rate', repCols.includes('commission_rate'), repCols.join(', '));

  const resCols = await colsOf('re_reservations');
  check('re_reservations has escalation_stage', resCols.includes('escalation_stage'), resCols.join(', '));

  const custCols = await colsOf('re_customers');
  check('re_customers has portal_token_version (the revoke button)',
    custCols.includes('portal_token_version'), custCols.join(', '));

  const unitCols = await colsOf('re_units');
  check('re_units has metadata (floor plans, photos)', unitCols.includes('metadata'), unitCols.join(', '));

  // ── The integrity locks ─────────────────────────────────────────────────
  const indexes = (await q(`select indexname from pg_indexes where schemaname='public'`))
    .map((r) => r.indexname);
  check('double-allocation index exists', indexes.includes('uniq_re_active_reservation_per_unit'));
  check('paystack reference index exists', indexes.includes('uniq_re_payments_paystack_reference'));
  check('one open promise per installment', indexes.includes('uniq_re_open_promise_per_schedule'));
  check('one receipt per payment', indexes.includes('uniq_re_documents_receipt_per_payment'));

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

  // ── 003: the rules the operations layer depends on ──────────────────────

  // Commission is idempotent on payment_id. This is what stops a replayed
  // Paystack webhook, or a re-recorded transfer, paying a rep twice for the
  // same money.
  const [{ id: repId }] = await q(
    `insert into re_sales_reps (organization_id, user_id, commission_rate)
     values ($1,$2,2.5) returning id`, [userId, userId]);
  const [{ id: liveReservation }] = await q(
    `select id from re_reservations where unit_id=$1 and status='reserved' limit 1`, [unitId]);
  const [{ id: paymentId }] = await q(
    `select id from re_payments where schedule_id=$1 limit 1`, [schedId]);

  await q(`insert into re_commissions (organization_id, sales_rep_id, reservation_id, payment_id, rate, base_amount, amount)
           values ($1,$2,$3,$4,2.5,3750000,93750)`, [userId, repId, liveReservation, paymentId]);

  let doubleAccrualBlocked = false;
  try {
    await q(`insert into re_commissions (organization_id, sales_rep_id, reservation_id, payment_id, rate, base_amount, amount)
             values ($1,$2,$3,$4,2.5,3750000,93750)`, [userId, repId, liveReservation, paymentId]);
  } catch (err) { doubleAccrualBlocked = /unique|duplicate/i.test(err.message); }
  check('database refuses a second commission accrual for one payment', doubleAccrualBlocked);

  let badRate = false;
  try {
    await q(`update re_sales_reps set commission_rate = 140 where id=$1`, [repId]);
  } catch (err) { badRate = /check/i.test(err.message); }
  check('commission_rate is constrained to 0–100', badRate);

  // A second promise on the same installment supersedes the first rather than
  // stacking — which is what "he keeps promising" means operationally.
  await q(`insert into re_payment_promises (organization_id, schedule_id, promised_date)
           values ($1,$2,'2026-03-15')`, [userId, schedId]);

  let secondOpenPromiseBlocked = false;
  try {
    await q(`insert into re_payment_promises (organization_id, schedule_id, promised_date)
             values ($1,$2,'2026-04-01')`, [userId, schedId]);
  } catch (err) { secondOpenPromiseBlocked = /unique|duplicate/i.test(err.message); }
  check('only one promise can be open against an installment', secondOpenPromiseBlocked);

  // Resolving the first must free the slot, or a buyer could never make a
  // second promise after breaking one.
  await q(`update re_payment_promises set status='broken', resolved_at=now() where schedule_id=$1`, [schedId]);
  let promiseAfterBroken = true;
  try {
    await q(`insert into re_payment_promises (organization_id, schedule_id, promised_date)
             values ($1,$2,'2026-04-01')`, [userId, schedId]);
  } catch (err) { promiseAfterBroken = false; console.log(`       ${err.message}`); }
  check('a resolved promise frees the slot for the next one', promiseAfterBroken);

  let badStage = false;
  try {
    await q(`update re_reservations set escalation_stage='nuclear' where id=$1`, [liveReservation]);
  } catch (err) { badStage = /check/i.test(err.message); }
  check('escalation_stage is constrained to the five known stages', badStage);

  // The audit log must outlive the person who wrote it, or it destroys its own
  // evidence the first time somebody leaves the company.
  await q(`insert into re_audit_log (organization_id, actor_id, actor_email, action, entity_type, entity_id, summary)
           values ($1,$2,'dev@example.com','payment.recorded','re_payments',$3,'₦3,750,000 received')`,
    [userId, userId, paymentId]);
  // actor_id deliberately carries NO foreign key: an audit row must survive
  // the deletion of the user who made it, or the log erases its own evidence
  // the first time somebody leaves the company.
  const [{ fkCount }] = await q(
    `select count(*)::int as "fkCount" from pg_constraint
     where conrelid = 'public.re_audit_log'::regclass and contype = 'f'`);
  check('re_audit_log has no foreign keys (rows outlive their actor)', fkCount === 0, `found ${fkCount}`);

  const [{ auditCount }] = await q(
    `select count(*)::int as "auditCount" from re_audit_log where entity_id=$1`, [paymentId]);
  check('audit entries are queryable by entity', auditCount === 1, `found ${auditCount}`);

  // One receipt per payment.
  await q(`insert into re_documents (organization_id, reservation_id, payment_id, doc_type)
           values ($1,$2,$3,'receipt')`, [userId, liveReservation, paymentId]);
  let secondReceiptBlocked = false;
  try {
    await q(`insert into re_documents (organization_id, reservation_id, payment_id, doc_type)
             values ($1,$2,$3,'receipt')`, [userId, liveReservation, paymentId]);
  } catch (err) { secondReceiptBlocked = /unique|duplicate/i.test(err.message); }
  check('database refuses a second receipt for one payment', secondReceiptBlocked);

  // …but a payment may still have an allocation letter alongside its receipt,
  // because the index is partial on doc_type.
  let otherDocOk = true;
  try {
    await q(`insert into re_documents (organization_id, reservation_id, doc_type)
             values ($1,$2,'allocation_letter')`, [userId, liveReservation]);
  } catch (err) { otherDocOk = false; console.log(`       ${err.message}`); }
  check('the receipt lock does not block other document types', otherDocOk);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err.message);
  process.exit(1);
});
