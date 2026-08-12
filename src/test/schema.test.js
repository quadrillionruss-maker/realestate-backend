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
    for (const file of ['001_phase1_schema.sql', '002_ai_briefs.sql', '003_operations.sql', '004_hardening.sql', '005_soft_delete_and_lifecycle.sql', '006_rentals.sql', '007_payment_reallocation.sql', '008_payment_void.sql', '009_account_lockout.sql', '010_daily_job_scale.sql', '011_payer_name.sql', '012_invite_dedup.sql', '013_ai_task_dedup.sql', '014_performance_indexes.sql', '015_team_logo.sql', '016_rbac.sql',
      '017_paystack_org_keys.sql', '018_resend_org_keys.sql', '019_termii_org_keys.sql', '020_commission_rate_snapshot.sql']) {
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

  for (const file of ['001_phase1_schema.sql', '002_ai_briefs.sql', '003_operations.sql', '004_hardening.sql', '005_soft_delete_and_lifecycle.sql', '006_rentals.sql', '007_payment_reallocation.sql', '008_payment_void.sql', '009_account_lockout.sql', '010_daily_job_scale.sql', '011_payer_name.sql', '012_invite_dedup.sql', '013_ai_task_dedup.sql', '014_performance_indexes.sql', '015_team_logo.sql', '016_rbac.sql',
      '017_paystack_org_keys.sql', '018_resend_org_keys.sql', '019_termii_org_keys.sql', '020_commission_rate_snapshot.sql']) {
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
    'last_login_at', 'avatar_url', 'token_version'];
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
  check('one allocation letter per reservation',
    indexes.includes('uniq_re_allocation_letter_per_reservation'));

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

  // ── 004: hardening ──────────────────────────────────────────────────────

  // The insert above put ONE allocation letter on this reservation. A second is
  // three letters in circulation for one unit, which in a dispute is worse than
  // none — so the database refuses it.
  let secondLetterBlocked = false;
  try {
    await q(`insert into re_documents (organization_id, reservation_id, doc_type)
             values ($1,$2,'allocation_letter')`, [userId, liveReservation]);
  } catch (err) { secondLetterBlocked = /unique|duplicate/i.test(err.message); }
  check('database refuses a second allocation letter for one reservation', secondLetterBlocked);

  // token_version is what makes a fired employee's unexpired token stop
  // working. It must default to 0, so deploying 004 does not sign everyone out.
  const [{ tv }] = await q(`select token_version as tv from users where id=$1`, [userId]);
  check('users.token_version defaults to 0 (existing sessions survive the migration)',
    Number(tv) === 0, `got ${tv}`);

  await q(`update users set token_version = token_version + 1 where id=$1`, [userId]);
  const [{ tv2 }] = await q(`select token_version as tv2 from users where id=$1`, [userId]);
  check('token_version increments', Number(tv2) === 1, `got ${tv2}`);

  // Overpayment is recorded, never negative.
  let negativeOverpaymentBlocked = false;
  try {
    await q(`update re_payments set overpayment = -1 where schedule_id=$1`, [schedId]);
  } catch (err) { negativeOverpaymentBlocked = /check/i.test(err.message); }
  check('overpayment cannot be negative', negativeOverpaymentBlocked);

  // ── 005: soft delete, and the locks rebuilt around it ───────────────────

  for (const t of ['re_projects', 're_units', 're_customers', 're_reservations',
    're_installment_plans', 're_installment_schedule', 're_payments', 're_documents',
    're_tasks', 're_commissions', 're_payment_promises']) {
    const cols = await colsOf(t);
    check(`${t} has deleted_at + deleted_by`,
      cols.includes('deleted_at') && cols.includes('deleted_by'), cols.join(', '));
  }

  // The two log tables deliberately have NO deleted_at: a nullable one would
  // imply the evidence can be withdrawn.
  for (const t of ['re_audit_log', 're_notifications']) {
    const cols = await colsOf(t);
    check(`${t} has NO deleted_at (evidence cannot be withdrawn)`,
      !cols.includes('deleted_at'), cols.join(', '));
  }

  const verifyCols = ['email_verified_at', 'verify_token_hash', 'verify_token_expires_at'];
  check('users has the email-verification columns',
    verifyCols.every((c) => userCols.includes(c)),
    `missing: ${verifyCols.filter((c) => !userCols.includes(c)).join(', ')}`);

  // Existing accounts are backfilled as verified — deploying the requirement
  // must not lock out everybody who signed up before it existed.
  //
  // The users created further up in this file were inserted AFTER 005 first
  // ran, so they are legitimately unverified. Re-applying the migration is what
  // exercises the backfill, and it also proves that step is idempotent rather
  // than only safe the first time.
  const [{ unverifiedBefore }] = await q(
    `select count(*)::int as "unverifiedBefore" from users where email_verified_at is null`);
  check('a user created after the migration starts out unverified',
    unverifiedBefore > 0, `${unverifiedBefore}`);

  await db.exec(fs.readFileSync(`${M}/005_soft_delete_and_lifecycle.sql`, 'utf8'));

  const [{ unverifiedAfter }] = await q(
    `select count(*)::int as "unverifiedAfter" from users where email_verified_at is null`);
  check('re-running 005 backfills every unverified account',
    unverifiedAfter === 0, `${unverifiedAfter} still null`);

  const planCols = await colsOf('re_installment_plans');
  const lifecycleCols = ['status', 'superseded_by', 'restructured_at',
    'original_total_amount', 'carried_amount_paid'];
  check('re_installment_plans has the restructuring columns',
    lifecycleCols.every((c) => planCols.includes(c)),
    `missing: ${lifecycleCols.filter((c) => !planCols.includes(c)).join(', ')}`);

  // ── THE MOST IMPORTANT CHECK IN THIS FILE ────────────────────────────────
  // 005 dropped and recreated the double-allocation index to add
  // "deleted_at is null". Get that predicate wrong and one unit can be sold to
  // two buyers — the failure this whole product exists to prevent.
  const [{ id: lockProject }] = await q(
    `insert into re_projects (organization_id, name) values ($1,'Lock Test') returning id`, [userId]);
  const [{ id: lockUnit }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price)
     values ($1,$2,'LOCK-1',1000000) returning id`, [userId, lockProject]);
  const [{ id: lockBuyerA }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Lock Buyer A') returning id`, [userId]);
  const [{ id: lockBuyerB }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Lock Buyer B') returning id`, [userId]);

  const [{ id: lockRes }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id)
     values ($1,$2,$3) returning id`, [userId, lockUnit, lockBuyerA]);

  let stillBlocked = false;
  try {
    await q(`insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3)`,
      [userId, lockUnit, lockBuyerB]);
  } catch (err) { stillBlocked = /unique|duplicate/i.test(err.message); }
  check('double allocation is STILL blocked after the index was rebuilt', stillBlocked);

  // A soft-deleted reservation must release the unit. Otherwise deleting one by
  // mistake would make that unit permanently unsellable to anybody.
  await q(`update re_reservations set deleted_at = now() where id=$1`, [lockRes]);
  let freedAfterDelete = true;
  try {
    await q(`insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3)`,
      [userId, lockUnit, lockBuyerB]);
  } catch (err) { freedAfterDelete = false; console.log(`       ${err.message}`); }
  check('a soft-deleted reservation frees the unit again', freedAfterDelete);

  // Same question for unit numbers: a deleted unit must not reserve its own
  // number forever.
  const [{ id: delUnit }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price)
     values ($1,$2,'REUSE-1',1) returning id`, [userId, lockProject]);
  let numberTaken = false;
  try {
    await q(`insert into re_units (organization_id, project_id, unit_number, list_price)
             values ($1,$2,'REUSE-1',1)`, [userId, lockProject]);
  } catch (err) { numberTaken = /unique|duplicate/i.test(err.message); }
  check('a live unit number cannot be duplicated', numberTaken);

  await q(`update re_units set deleted_at = now() where id=$1`, [delUnit]);
  let numberReusable = true;
  try {
    await q(`insert into re_units (organization_id, project_id, unit_number, list_price)
             values ($1,$2,'REUSE-1',1)`, [userId, lockProject]);
  } catch (err) { numberReusable = false; console.log(`       ${err.message}`); }
  check('a deleted unit releases its unit number', numberReusable);

  // Exactly one ACTIVE plan per reservation. Two means two schedules, two sets
  // of due dates, and a dashboard that counts the same debt twice.
  const [{ id: planRes }] = await q(
    `select id from re_reservations where unit_id=$1 and status='reserved' limit 1`, [lockUnit]);
  await q(`insert into re_installment_plans
             (organization_id, reservation_id, total_amount, number_of_installments, start_date)
           values ($1,$2,1000000,10,'2026-01-01')`, [userId, planRes]);

  let secondActivePlanBlocked = false;
  try {
    await q(`insert into re_installment_plans
               (organization_id, reservation_id, total_amount, number_of_installments, start_date)
             values ($1,$2,500000,5,'2026-01-01')`, [userId, planRes]);
  } catch (err) { secondActivePlanBlocked = /unique|duplicate/i.test(err.message); }
  check('a reservation cannot have two active plans', secondActivePlanBlocked);

  // …but superseding the first must let the replacement in, or restructuring
  // would be impossible.
  await q(`update re_installment_plans set status='superseded' where reservation_id=$1`, [planRes]);
  let restructureAllowed = true;
  try {
    await q(`insert into re_installment_plans
               (organization_id, reservation_id, total_amount, number_of_installments, start_date)
             values ($1,$2,500000,5,'2026-06-01')`, [userId, planRes]);
  } catch (err) { restructureAllowed = false; console.log(`       ${err.message}`); }
  check('superseding a plan makes room for the restructured one', restructureAllowed);

  let badPlanStatus = false;
  try {
    await q(`update re_installment_plans set status='whatever' where reservation_id=$1`, [planRes]);
  } catch (err) { badPlanStatus = /check/i.test(err.message); }
  check('plan status is constrained to active|superseded', badPlanStatus);

  // ── 006: rentals ─────────────────────────────────────────────────────────

  const rentCols = await colsOf('re_reservations');
  check('re_reservations has property_type', rentCols.includes('property_type'), rentCols.join(', '));
  check('re_reservations has tenancy_start_date and tenancy_end_date',
    rentCols.includes('tenancy_start_date') && rentCols.includes('tenancy_end_date'),
    rentCols.join(', '));

  // Existing reservations — the ones created earlier in this very file, before
  // 006 ran — must have been backfilled to 'off_plan', or every reservation
  // that predates this migration silently loses its type on deploy.
  const [{ untyped }] = await q(
    `select count(*)::int as untyped from re_reservations where property_type is null`);
  check('every existing reservation defaulted to a property_type', untyped === 0, `${untyped} null`);

  const [{ offPlanCount }] = await q(
    `select count(*)::int as "offPlanCount" from re_reservations where property_type = 'off_plan'`);
  check('reservations created before 006 read as off_plan', offPlanCount > 0, `${offPlanCount}`);

  let badPropertyType = false;
  try {
    await q(`update re_reservations set property_type='timeshare' where id=$1`, [planRes]);
  } catch (err) { badPropertyType = /check/i.test(err.message); }
  check('property_type is constrained to off_plan|outright|rental', badPropertyType);

  // An open-ended tenancy is a legitimate state — a null end date must not be
  // rejected the way a null start date should be (application-level, not the
  // database's job per the migration's own comment, but the COLUMN itself
  // must allow it).
  let openEndedTenancyAllowed = true;
  try {
    await q(`update re_reservations set property_type='rental', tenancy_start_date='2026-01-01',
             tenancy_end_date=null where id=$1`, [planRes]);
  } catch (err) { openEndedTenancyAllowed = false; console.log(`       ${err.message}`); }
  check('tenancy_end_date can be null for an open-ended tenancy', openEndedTenancyAllowed);

  // lease_agreement is a real doc_type now, and the existing types must still
  // work — this is the check most likely to be broken by a careless
  // drop/recreate of the constraint.
  let leaseAgreementAllowed = true;
  try {
    await q(`insert into re_documents (organization_id, reservation_id, doc_type)
             values ($1,$2,'lease_agreement')`, [userId, planRes]);
  } catch (err) { leaseAgreementAllowed = false; console.log(`       ${err.message}`); }
  check('lease_agreement is an accepted doc_type', leaseAgreementAllowed);

  let allocationLetterStillAllowed = true;
  try {
    await q(`insert into re_documents (organization_id, reservation_id, doc_type)
             values ($1, (select id from re_reservations where unit_id!=$2 limit 1),'deed_of_assignment')`,
      [userId, lockUnit]);
  } catch (err) { allocationLetterStillAllowed = false; console.log(`       ${err.message}`); }
  check('deed_of_assignment (an existing doc_type) still works after the constraint was rebuilt',
    allocationLetterStillAllowed);

  let badDocType = false;
  try {
    await q(`insert into re_documents (organization_id, reservation_id, doc_type)
             values ($1,$2,'eviction_notice')`, [userId, planRes]);
  } catch (err) { badDocType = /check/i.test(err.message); }
  check('an unknown doc_type is still refused', badDocType);

  // The renewal sweep's index has to actually exist, or the "which tenancies
  // expire soon" query is a sequential scan once there is real data.
  const [{ hasIndex }] = await q(
    `select exists(select 1 from pg_indexes where indexname='idx_re_reservations_tenancy_end') as "hasIndex"`);
  check('the tenancy-renewal sweep index exists', hasIndex);

  // ── 007: payment reallocation ────────────────────────────────────────────

  const paymentCols = await colsOf('re_payments');
  check('re_payments has reallocated_from_payment_id', paymentCols.includes('reallocated_from_payment_id'), paymentCols.join(', '));

  const [{ id: reallocTargetSched }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,2,'2026-02-01',3750000) returning id`, [userId, planId]);

  let reallocationAllowed = true;
  try {
    await q(`insert into re_payments (organization_id, schedule_id, amount, method, reallocated_from_payment_id)
             values ($1,$2,300000,'bank_transfer',$3)`, [userId, reallocTargetSched, paymentId]);
  } catch (err) { reallocationAllowed = false; console.log(`       ${err.message}`); }
  check('a payment credit can be reallocated to a different installment', reallocationAllowed);

  let doubleReallocationBlocked = false;
  try {
    await q(`insert into re_payments (organization_id, schedule_id, amount, method, reallocated_from_payment_id)
             values ($1,$2,100000,'bank_transfer',$3)`, [userId, schedId, paymentId]);
  } catch (err) { doubleReallocationBlocked = /unique|duplicate/i.test(err.message); }
  check('the same overpayment cannot be reallocated twice', doubleReallocationBlocked);

  // ── reallocating a CARD payment's overpayment must not collide with the
  // paystack-reference uniqueness index ────────────────────────────────────
  // src/services/paystackService.js reallocateOverpayment used to copy the
  // SOURCE payment's method AND paystack_reference straight onto the new
  // reallocation row. When the source was itself a card ('paystack')
  // payment, that meant the new row also got method='paystack' with the
  // SAME reference as its source — which uniq_re_payments_paystack_reference
  // (migrations/005: unique on paystack_reference where method='paystack'
  // and deleted_at is null) always refuses, so reallocating a card payment's
  // overpayment 23505'd on every attempt, misreported to the operator as
  // "this credit has already been allocated" when nothing had ever been. The
  // fix nulls paystack_reference on the reallocation row (method is still
  // carried, for reporting only) — provenance is already fully carried by
  // reallocated_from_payment_id.
  const [{ id: cardSourceSched }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,6,'2026-06-01',500000) returning id`, [userId, planId]);
  const cardSourceRef = `REINST-${cardSourceSched}-1750000099999`;
  const [{ id: cardSourcePayment }] = await q(
    `insert into re_payments (organization_id, schedule_id, amount, method, paystack_reference, overpayment)
     values ($1,$2,900000,'paystack',$3,400000) returning id`, [userId, cardSourceSched, cardSourceRef]);
  const [{ id: cardTargetSched }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,7,'2026-07-01',400000) returning id`, [userId, planId]);

  let cardReallocationOk = true;
  try {
    // Mirrors reallocateOverpayment's insert shape AFTER the fix: method
    // carried from the source, paystack_reference explicitly null.
    await q(`insert into re_payments (organization_id, schedule_id, amount, method, paystack_reference, reallocated_from_payment_id)
             values ($1,$2,400000,'paystack',null,$3)`, [userId, cardTargetSched, cardSourcePayment]);
  } catch (err) { cardReallocationOk = false; console.log(`       ${err.message}`); }
  check('reallocating a card payment\'s overpayment (paystack_reference nulled) does not collide with the paystack-reference index', cardReallocationOk);

  // Confirms the test above is actually meaningful: the OLD (pre-fix) shape —
  // copying the source's real reference onto a second 'paystack'-method row —
  // is still refused by the same index. If this ever stopped being refused,
  // the index itself changed and the fix above may no longer be necessary or
  // sufficient.
  const [{ id: secondCardTargetSched }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,8,'2026-08-01',400000) returning id`, [userId, planId]);
  let buggyShapeStillBlocked = false;
  try {
    await q(`insert into re_payments (organization_id, schedule_id, amount, method, paystack_reference)
             values ($1,$2,400000,'paystack',$3)`, [userId, secondCardTargetSched, cardSourceRef]);
  } catch (err) { buggyShapeStillBlocked = /unique|duplicate/i.test(err.message); }
  check('copying the source reference onto a second paystack-method row (the pre-fix behaviour) is still refused', buggyShapeStillBlocked);

  // ── 008: voiding a wrongly recorded payment ──────────────────────────────

  const voidCols = await colsOf('re_payments');
  check('re_payments has voided_at and void_reason', voidCols.includes('voided_at') && voidCols.includes('void_reason'), voidCols.join(', '));

  let voidAllowed = true;
  try {
    await q(`update re_payments set voided_at=now(), void_reason='entered in error' where id=$1`, [paymentId]);
  } catch (err) { voidAllowed = false; console.log(`       ${err.message}`); }
  check('a payment can be marked voided', voidAllowed);

  // Voiding a reallocation must free its source to be reallocated again —
  // otherwise the "one reallocation per payment" index would permanently
  // lock out a correction to a misallocated credit.
  const [{ id: freshSourceSched }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,3,'2026-03-01',500000) returning id`, [userId, planId]);
  const [{ id: freshSourcePayment }] = await q(
    `insert into re_payments (organization_id, schedule_id, amount, method, overpayment)
     values ($1,$2,900000,'bank_transfer',400000) returning id`, [userId, freshSourceSched]);
  const [{ id: freshTargetSched }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,4,'2026-04-01',400000) returning id`, [userId, planId]);

  await q(`insert into re_payments (organization_id, schedule_id, amount, method, reallocated_from_payment_id)
           values ($1,$2,400000,'bank_transfer',$3)`, [userId, freshTargetSched, freshSourcePayment]);
  await q(`update re_payments set voided_at=now(), void_reason='wrong installment'
           where reallocated_from_payment_id=$1`, [freshSourcePayment]);

  let reallocationAfterVoidAllowed = true;
  try {
    await q(`insert into re_payments (organization_id, schedule_id, amount, method, reallocated_from_payment_id)
             values ($1,$2,400000,'bank_transfer',$3)`, [userId, freshTargetSched, freshSourcePayment]);
  } catch (err) { reallocationAfterVoidAllowed = false; console.log(`       ${err.message}`); }
  check('voiding a reallocation frees its source to be reallocated again', reallocationAfterVoidAllowed);

  // ── 009: per-account login lockout ───────────────────────────────────────

  const lockoutCols = await colsOf('users');
  check('users has failed_login_count and locked_until',
    lockoutCols.includes('failed_login_count') && lockoutCols.includes('locked_until'), lockoutCols.join(', '));

  const [{ failed_login_count: defaultFailedCount }] = await q(
    `select failed_login_count from users where id=$1`, [userId]);
  check('failed_login_count defaults to 0', Number(defaultFailedCount) === 0, `${defaultFailedCount}`);

  // ── 010: distinct_reservation_org_ids() backs the daily job's org fan-out ──

  let orgIdsFromRpc = [];
  try {
    orgIdsFromRpc = (await q(`select * from distinct_reservation_org_ids()`)).map((r) => r.organization_id);
  } catch (err) { console.log(`       ${err.message}`); }
  check('distinct_reservation_org_ids() is callable and includes an org with a live reservation',
    orgIdsFromRpc.includes(userId), orgIdsFromRpc.join(', '));

  // ── 011: payer_name on a manual payment ──────────────────────────────────

  const payerCols = await colsOf('re_payments');
  check('re_payments has payer_name', payerCols.includes('payer_name'), payerCols.join(', '));

  let payerNameStored = false;
  try {
    const [{ id: payerSched }] = await q(
      `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
       values ($1,$2,5,'2026-05-01',500000) returning id`, [userId, planId]);
    const [{ payer_name }] = await q(
      `insert into re_payments (organization_id, schedule_id, amount, method, payer_name)
       values ($1,$2,500000,'bank_transfer','A relative of the buyer') returning payer_name`,
      [userId, payerSched]);
    payerNameStored = payer_name === 'A relative of the buyer';
  } catch (err) { console.log(`       ${err.message}`); }
  check('a payment records who actually paid', payerNameStored);

  // ── 012: one pending invite per email, per team ──────────────────────────

  let secondInviteBlocked = false;
  try {
    await q(`insert into team_members (team_id, invited_email, role, status)
             values ($1,'invitee@example.com','sales_rep','invited')`, [teamId]);
    await q(`insert into team_members (team_id, invited_email, role, status)
             values ($1,'invitee@example.com','sales_rep','invited')`, [teamId]);
  } catch (err) { secondInviteBlocked = /unique|duplicate/i.test(err.message); }
  check('a pending invite cannot be duplicated for the same team and email', secondInviteBlocked);

  // ── 013: one open AI task per title, per org ─────────────────────────────

  let secondAiTaskBlocked = false;
  try {
    await q(`insert into re_tasks (organization_id, title, source, status)
             values ($1,'Renew tenancy for Unit A1','ai','open')`, [userId]);
    await q(`insert into re_tasks (organization_id, title, source, status)
             values ($1,'Renew tenancy for Unit A1','ai','open')`, [userId]);
  } catch (err) { secondAiTaskBlocked = /unique|duplicate/i.test(err.message); }
  check('a duplicate open AI task with the same title is refused', secondAiTaskBlocked);

  let manualTaskWithSameTitleOk = true;
  try {
    await q(`insert into re_tasks (organization_id, title, source, status)
             values ($1,'Renew tenancy for Unit A1','manual','open')`, [userId]);
  } catch (err) { manualTaskWithSameTitleOk = false; console.log(`       ${err.message}`); }
  check('a manual task with the same title is not blocked by the AI-task index', manualTaskWithSameTitleOk);

  // ── 014: indexes for the sweep and the commissions list ──────────────────

  const perfIndexes = (await q(
    `select indexname from pg_indexes where indexname in
     ('idx_re_promises_status_date','idx_re_commissions_org_created')`)).map((r) => r.indexname);
  check('idx_re_promises_status_date exists', perfIndexes.includes('idx_re_promises_status_date'));
  check('idx_re_commissions_org_created exists', perfIndexes.includes('idx_re_commissions_org_created'));

  // ── 015: team logo ───────────────────────────────────────────────────────

  const teamLogoCols = await colsOf('teams');
  check('teams has logo_url', teamLogoCols.includes('logo_url'), teamLogoCols.join(', '));

  let logoStored = false;
  try {
    const [{ logo_url }] = await q(
      `update teams set logo_url=$1 where id=$2 returning logo_url`,
      ['https://example.supabase.co/storage/v1/object/public/public-assets/logos/x/logo-1.png', teamId]);
    logoStored = logo_url != null;
  } catch (err) { console.log(`       ${err.message}`); }
  check('a team logo url can be stored', logoStored);

  // ── 016: RBAC ─────────────────────────────────────────────────────────────

  const roleCols = await colsOf('team_members');
  check('team_members has invited_role, invite_token, invite_expires_at',
    ['invited_role', 'invite_token', 'invite_expires_at'].every((c) => roleCols.includes(c)), roleCols.join(', '));

  const customerCols = await colsOf('re_customers');
  check('re_customers has created_by_user_id', customerCols.includes('created_by_user_id'), customerCols.join(', '));

  let oldRoleBlocked = false;
  try {
    await q(`insert into team_members (team_id, user_id, role) values ($1,$2,'admin')`, [teamId, userId]);
  } catch (err) { oldRoleBlocked = /check/i.test(err.message); }
  check('the old admin/member roles are refused by the tightened check constraint', oldRoleBlocked);

  let allNewRolesAccepted = true;
  const newRoleUsers = [];
  for (const role of ['sales_director', 'sales_rep', 'collections', 'documentation']) {
    try {
      const [{ id: newUserId }] = await q(
        `insert into users (email, full_name) values ($1,'RBAC Test') returning id`, [`${role}@example.com`]);
      await q(`insert into team_members (team_id, user_id, role) values ($1,$2,$3)`, [teamId, newUserId, role]);
      newRoleUsers.push({ role, userId: newUserId });
    } catch (err) { allNewRolesAccepted = false; console.log(`       ${role}: ${err.message}`); }
  }
  check('all five new roles are accepted by the check constraint', allNewRolesAccepted);

  // ── Sales Executive row-level filtering ─────────────────────────────────
  // The exact behaviour "Sales Rep filtered query only returns their own
  // buyers" — two buyers, created by two different people, and the query
  // routes/customers.js actually runs for a sales_rep (created_by_user_id =
  // caller) must return only the one that is theirs.
  const salesRepUser = newRoleUsers.find((u) => u.role === 'sales_rep');
  let ownBuyersFilterCorrect = false;
  if (salesRepUser) {
    const [{ id: theirBuyer }] = await q(
      `insert into re_customers (organization_id, full_name, created_by_user_id)
       values ($1,'Owned By Rep',$2) returning id`, [teamId, salesRepUser.userId]);
    const [{ id: othersBuyer }] = await q(
      `insert into re_customers (organization_id, full_name, created_by_user_id)
       values ($1,'Owned By Someone Else',$2) returning id`, [teamId, userId]);

    const filtered = await q(
      `select id from re_customers where organization_id=$1 and created_by_user_id=$2 and deleted_at is null`,
      [teamId, salesRepUser.userId]);
    const ids = filtered.map((r) => r.id);
    ownBuyersFilterCorrect = ids.includes(theirBuyer) && !ids.includes(othersBuyer);
  }
  check('a sales rep\'s filtered buyer query returns only their own, not a colleague\'s', ownBuyersFilterCorrect);

  // ── Invite with role adds member with correct role ──────────────────────
  // Mirrors inviteService.createInvite's insert shape for a not-yet-registered
  // invitee: role and invited_role both carry the offered role, status stays
  // 'invited' (grants nothing — src/middleware/auth.js only counts 'active'),
  // and a token with an expiry is attached.
  let invitedRoleCorrect = false;
  try {
    const [row] = await q(
      `insert into team_members (team_id, invited_email, role, invited_role, status, invite_token, invite_expires_at)
       values ($1,'newhire@example.com','collections','collections','invited','tok_abc123',now() + interval '7 days')
       returning role, invited_role, status`,
      [teamId]);
    invitedRoleCorrect = row.role === 'collections' && row.invited_role === 'collections' && row.status === 'invited';
  } catch (err) { console.log(`       ${err.message}`); }
  check('an invite with a role adds a pending member carrying that role', invitedRoleCorrect);

  // ── 11th workspace invite rejected ───────────────────────────────────────
  // inviteService.workspaceCountFor counts DISTINCT team_id across
  // active+invited membership for one person; wouldExceedWorkspaceCap (pure,
  // asserted in logic.test.js) then refuses a count >= 10. This proves the
  // counting QUERY itself — ten distinct teams for one user — comes back as
  // exactly ten, which is the fact that pure check is applied to.
  const [{ id: capUserId }] = await q(
    `insert into users (email, full_name) values ('cap-test@example.com','Cap Test') returning id`);
  for (let i = 0; i < 10; i += 1) {
    const [{ id: extraTeamId }] = await q(
      `insert into teams (name, owner_id) values ($1,$2) returning id`, [`Cap Team ${i}`, capUserId]);
    await q(`insert into team_members (team_id, user_id, role, status) values ($1,$2,'owner','active')`,
      [extraTeamId, capUserId]);
  }
  const [{ workspaceCount }] = await q(
    `select count(distinct team_id)::int as "workspaceCount" from team_members
     where user_id=$1 and status in ('active','invited')`, [capUserId]);
  check('a person already in ten workspaces counts as exactly ten', workspaceCount === 10, `${workspaceCount}`);

  // ── 017: per-workspace Paystack keys ─────────────────────────────────────

  const orgSettingsCols = await colsOf('re_org_settings');
  check('re_org_settings has the Paystack credential columns',
    ['paystack_secret_key_encrypted', 'paystack_secret_key_last4', 'paystack_public_key']
      .every((c) => orgSettingsCols.includes(c)),
    orgSettingsCols.join(', '));

  let paystackKeyStored = false;
  try {
    const [{ paystack_secret_key_encrypted, paystack_secret_key_last4, paystack_public_key }] = await q(
      `insert into re_org_settings (organization_id, paystack_secret_key_encrypted, paystack_secret_key_last4, paystack_public_key)
       values ($1,'ZmFrZS1jaXBoZXJ0ZXh0','7f3a','pk_live_abc123')
       on conflict (organization_id) do update set
         paystack_secret_key_encrypted=excluded.paystack_secret_key_encrypted,
         paystack_secret_key_last4=excluded.paystack_secret_key_last4,
         paystack_public_key=excluded.paystack_public_key
       returning paystack_secret_key_encrypted, paystack_secret_key_last4, paystack_public_key`, [userId]);
    paystackKeyStored = paystack_secret_key_encrypted === 'ZmFrZS1jaXBoZXJ0ZXh0'
      && paystack_secret_key_last4 === '7f3a' && paystack_public_key === 'pk_live_abc123';
  } catch (err) { console.log(`       ${err.message}`); }
  check('an org Paystack key round-trips through the row (encrypted text + last4 + public key)', paystackKeyStored);

  // A workspace that never configures its own key is the default and the
  // common case — the columns must allow that, not require a value.
  const [{ id: noKeyOrg }] = await q(
    `insert into users (email, full_name) values ('no-paystack-key@example.com','No Key') returning id`);
  let noKeyOrgOk = true;
  try {
    await q(`insert into re_org_settings (organization_id) values ($1)`, [noKeyOrg]);
  } catch (err) { noKeyOrgOk = false; console.log(`       ${err.message}`); }
  check('re_org_settings can be created with no Paystack key at all', noKeyOrgOk);

  // ── 018: per-workspace Resend (email) credentials ────────────────────────

  check('re_org_settings has the Resend credential columns',
    ['resend_api_key_encrypted', 'resend_api_key_last4', 'resend_from_email']
      .every((c) => orgSettingsCols.includes(c)),
    orgSettingsCols.join(', '));

  let resendCredentialsStored = false;
  try {
    const [{ resend_api_key_encrypted, resend_api_key_last4, resend_from_email }] = await q(
      `update re_org_settings set
         resend_api_key_encrypted='ZmFrZS1yZXNlbmQta2V5',
         resend_api_key_last4='9c21',
         resend_from_email='receipts@developer-domain.com'
       where organization_id=$1
       returning resend_api_key_encrypted, resend_api_key_last4, resend_from_email`, [userId]);
    resendCredentialsStored = resend_api_key_encrypted === 'ZmFrZS1yZXNlbmQta2V5'
      && resend_api_key_last4 === '9c21' && resend_from_email === 'receipts@developer-domain.com';
  } catch (err) { console.log(`       ${err.message}`); }
  check('an org Resend key + from-address round-trips through the row', resendCredentialsStored);

  // ── 019: per-workspace Termii (SMS) credentials ──────────────────────────

  check('re_org_settings has the Termii credential columns',
    ['termii_api_key_encrypted', 'termii_api_key_last4', 'termii_sender_id']
      .every((c) => orgSettingsCols.includes(c)),
    orgSettingsCols.join(', '));

  let termiiCredentialsStored = false;
  try {
    const [{ termii_api_key_encrypted, termii_api_key_last4, termii_sender_id }] = await q(
      `update re_org_settings set
         termii_api_key_encrypted='ZmFrZS10ZXJtaWkta2V5',
         termii_api_key_last4='4a1f',
         termii_sender_id='Adron'
       where organization_id=$1
       returning termii_api_key_encrypted, termii_api_key_last4, termii_sender_id`, [userId]);
    termiiCredentialsStored = termii_api_key_encrypted === 'ZmFrZS10ZXJtaWkta2V5'
      && termii_api_key_last4 === '4a1f' && termii_sender_id === 'Adron';
  } catch (err) { console.log(`       ${err.message}`); }
  check('an org Termii key + sender id round-trips through the row', termiiCredentialsStored);

  // ── 020: commission rate snapshotted onto the reservation ────────────────
  const reservationCols = (await q(
    `select column_name from information_schema.columns where table_name='re_reservations'`
  )).map((r) => r.column_name);
  check('re_reservations has commission_rate', reservationCols.includes('commission_rate'), reservationCols.join(', '));

  let commissionSnapshotSurvivesRateChange = false;
  try {
    const [{ id: rateProjectId }] = await q(
      `insert into re_projects (organization_id, name) values ($1,'Rate Snapshot Estate') returning id`, [userId]);
    const [{ id: rateUnitId }] = await q(
      `insert into re_units (organization_id, project_id, unit_number, list_price)
       values ($1,$2,'RS-1',9000000) returning id`, [userId, rateProjectId]);
    const [{ id: rateCustomerId }] = await q(
      `insert into re_customers (organization_id, full_name) values ($1,'Rate Snapshot Buyer') returning id`, [userId]);
    const [{ id: rateRepUserId }] = await q(
      `insert into users (email, full_name) values ('rate-snapshot-rep@example.com','Rate Rep') returning id`);
    const [{ id: rateRepId }] = await q(
      `insert into re_sales_reps (organization_id, user_id, commission_rate)
       values ($1,$2,5) returning id`, [userId, rateRepUserId]);

    // Sold while the rep was on 5% — routes/reservations.js copies the rep's
    // rate at creation, which this simulates directly.
    const [{ id: rateReservationId }] = await q(
      `insert into re_reservations (organization_id, unit_id, customer_id, sales_rep_id, commission_rate)
       values ($1,$2,$3,$4,5) returning id`, [userId, rateUnitId, rateCustomerId, rateRepId]);

    // The rep's rate moves after the sale — commission on installments still
    // to come on THIS reservation must not follow it.
    await q(`update re_sales_reps set commission_rate=8 where id=$1`, [rateRepId]);

    const [{ commission_rate: survivingRate }] = await q(
      `select commission_rate from re_reservations where id=$1`, [rateReservationId]);
    commissionSnapshotSurvivesRateChange = Number(survivingRate) === 5;
  } catch (err) { console.log(`       ${err.message}`); }
  check("a reservation's commission rate does not follow a later change to the rep's rate",
    commissionSnapshotSurvivesRateChange);

  let commissionRateBackfilled = false;
  try {
    const [{ id: backfillRepUserId }] = await q(
      `insert into users (email, full_name) values ('backfill-rep@example.com','Backfill Rep') returning id`);
    const [{ id: backfillRepId }] = await q(
      `insert into re_sales_reps (organization_id, user_id, commission_rate)
       values ($1,$2,3.5) returning id`, [userId, backfillRepUserId]);
    const [{ id: backfillUnitId }] = await q(
      `insert into re_units (organization_id, project_id, unit_number, list_price)
       values ($1,(select id from re_projects where organization_id=$1 limit 1),'RS-2',6000000) returning id`, [userId]);
    const [{ id: backfillCustomerId }] = await q(
      `insert into re_customers (organization_id, full_name) values ($1,'Backfill Buyer') returning id`, [userId]);
    // No commission_rate given — simulates a row written before 020 existed.
    const [{ id: backfillReservationId }] = await q(
      `insert into re_reservations (organization_id, unit_id, customer_id, sales_rep_id)
       values ($1,$2,$3,$4) returning id`, [userId, backfillUnitId, backfillCustomerId, backfillRepId]);

    // The exact backfill statement from migrations/020, re-run the way a
    // re-applied migration would — idempotent, so this must be safe to do.
    await q(
      `update re_reservations r set commission_rate = rs.commission_rate
       from re_sales_reps rs where r.sales_rep_id = rs.id and r.commission_rate is null`);

    const [{ commission_rate: backfilledRate }] = await q(
      `select commission_rate from re_reservations where id=$1`, [backfillReservationId]);
    commissionRateBackfilled = Number(backfilledRate) === 3.5;
  } catch (err) { console.log(`       ${err.message}`); }
  check('re-running the 020 backfill fills a pre-existing reservation\'s rate from its rep',
    commissionRateBackfilled);

  // ── Soft-deleted buyer PATCH exclusion (routes/customers.js) ────────────
  // orgContext's automatic deleted_at filter only wraps .select() — an
  // update-then-select chain like PATCH /:id used to be unfiltered.
  const [{ id: softDeleteCustomerId }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Soft Deleted Buyer') returning id`, [userId]);
  await q(`update re_customers set deleted_at = now() where id=$1`, [softDeleteCustomerId]);

  let patchMatchedDeletedBuyer = true;
  try {
    const patched = await q(
      `update re_customers set full_name='Hijacked Name' where id=$1 and organization_id=$2 and deleted_at is null returning id`,
      [softDeleteCustomerId, userId]);
    patchMatchedDeletedBuyer = patched.length > 0;
  } catch (err) { console.log(`       ${err.message}`); }
  check('a PATCH-style update with deleted_at is null does NOT match a soft-deleted buyer', !patchMatchedDeletedBuyer);

  const [{ full_name: nameAfterAttempt }] = await q(`select full_name from re_customers where id=$1`, [softDeleteCustomerId]);
  check('the soft-deleted buyer\'s name is unchanged after the blocked update', nameAfterAttempt === 'Soft Deleted Buyer');

  // ── Commission transition guard: paid_at clearing + soft-delete exclusion
  // (routes/commissions.js PATCH /status) ──────────────────────────────────
  const [{ id: commSchedId }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,20,'2026-09-01',200000) returning id`, [userId, planId]);
  const [{ id: commPaymentId }] = await q(
    `insert into re_payments (organization_id, schedule_id, amount, method) values ($1,$2,200000,'bank_transfer') returning id`,
    [userId, commSchedId]);
  const [{ id: paidCommissionId }] = await q(
    `insert into re_commissions (organization_id, sales_rep_id, reservation_id, payment_id, rate, base_amount, amount, status, paid_at)
     values ($1,$2,$3,$4,2.5,200000,5000,'paid', now()) returning id`, [userId, repId, liveReservation, commPaymentId]);

  // Moving a PAID commission back to 'accrued' must clear the stale
  // paid_at — the exact update shape routes/commissions.js now writes
  // whenever ANY targeted row is currently 'paid', regardless of what
  // status was requested.
  let paidAtCleared = false;
  try {
    const [row] = await q(
      `update re_commissions set status='accrued', paid_at=null where id=$1 and organization_id=$2 and deleted_at is null returning status, paid_at`,
      [paidCommissionId, userId]);
    paidAtCleared = row.status === 'accrued' && row.paid_at === null;
  } catch (err) { console.log(`       ${err.message}`); }
  check('moving a commission off \'paid\' clears its stale paid_at', paidAtCleared);

  // A soft-deleted commission (e.g. cascaded from a deleted buyer) must not
  // be reachable by the same update shape — it stays invisible everywhere
  // else, so a write must not be able to mark it paid either.
  const [{ id: commSchedId2 }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,21,'2026-10-01',200000) returning id`, [userId, planId]);
  const [{ id: commPaymentId2 }] = await q(
    `insert into re_payments (organization_id, schedule_id, amount, method) values ($1,$2,200000,'bank_transfer') returning id`,
    [userId, commSchedId2]);
  const [{ id: deletedCommissionId }] = await q(
    `insert into re_commissions (organization_id, sales_rep_id, reservation_id, payment_id, rate, base_amount, amount, status)
     values ($1,$2,$3,$4,2.5,200000,5000,'accrued') returning id`, [userId, repId, liveReservation, commPaymentId2]);
  await q(`update re_commissions set deleted_at = now() where id=$1`, [deletedCommissionId]);

  let deletedCommissionMatched = true;
  try {
    const updated = await q(
      `update re_commissions set status='paid', paid_at=now() where id=$1 and organization_id=$2 and deleted_at is null returning id`,
      [deletedCommissionId, userId]);
    deletedCommissionMatched = updated.length > 0;
  } catch (err) { console.log(`       ${err.message}`); }
  check('a soft-deleted commission cannot be matched and marked paid by the same update shape', !deletedCommissionMatched);

  // ── Reallocation same-buyer check: schedule → plan → reservation →
  // customer_id chain (routes/payments.js reallocate route) ───────────────
  const [{ id: reallocProjectId }] = await q(
    `insert into re_projects (organization_id, name) values ($1,'Realloc Check Estate') returning id`, [userId]);
  const [{ id: reallocUnitA }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price) values ($1,$2,'RA-1',5000000) returning id`,
    [userId, reallocProjectId]);
  const [{ id: reallocUnitB }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price) values ($1,$2,'RA-2',5000000) returning id`,
    [userId, reallocProjectId]);
  const [{ id: reallocBuyerA }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Realloc Buyer A') returning id`, [userId]);
  const [{ id: reallocBuyerB }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Realloc Buyer B') returning id`, [userId]);
  const [{ id: reallocResA }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3) returning id`,
    [userId, reallocUnitA, reallocBuyerA]);
  const [{ id: reallocResB }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3) returning id`,
    [userId, reallocUnitB, reallocBuyerB]);
  const [{ id: reallocPlanA }] = await q(
    `insert into re_installment_plans (organization_id, reservation_id, total_amount, number_of_installments, start_date)
     values ($1,$2,5000000,10,'2026-01-01') returning id`, [userId, reallocResA]);
  const [{ id: reallocPlanB }] = await q(
    `insert into re_installment_plans (organization_id, reservation_id, total_amount, number_of_installments, start_date)
     values ($1,$2,5000000,10,'2026-01-01') returning id`, [userId, reallocResB]);
  const [{ id: reallocSchedA }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,1,'2026-01-01',500000) returning id`, [userId, reallocPlanA]);
  const [{ id: reallocSchedA2 }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,2,'2026-02-01',500000) returning id`, [userId, reallocPlanA]);
  const [{ id: reallocSchedB }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,1,'2026-01-01',500000) returning id`, [userId, reallocPlanB]);

  // Mirrors the exact join path routes/payments.js's reallocate route now
  // walks BEFORE calling reallocateOverpayment, on both the source
  // payment's schedule and the proposed target schedule.
  const customerIdForSchedule = async (scheduleId) => {
    const [row] = await q(
      `select res.customer_id from re_installment_schedule s
       join re_installment_plans p on p.id = s.plan_id
       join re_reservations res on res.id = p.reservation_id
       where s.id = $1`, [scheduleId]);
    return row.customer_id;
  };

  const sourceCustomer = await customerIdForSchedule(reallocSchedA);
  const sameBuyerTargetCustomer = await customerIdForSchedule(reallocSchedA2);
  const differentBuyerTargetCustomer = await customerIdForSchedule(reallocSchedB);

  check('the chain query resolves a schedule to its own buyer\'s customer_id', sourceCustomer === reallocBuyerA);
  check('two installments on the SAME buyer\'s own reservation resolve to the SAME customer_id — reallocation between them is allowed',
    sourceCustomer === sameBuyerTargetCustomer);
  check('two DIFFERENT buyers\' schedules resolve to two DIFFERENT customer_ids — the mismatch the guard refuses',
    sourceCustomer !== differentBuyerTargetCustomer);

  // ── Waived row / superseded plan guard (routes/payments.js record route) ─
  const [{ id: waivedGuardSchedId }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due, status)
     values ($1,$2,22,'2026-11-01',300000,'waived') returning id`, [userId, planId]);

  const guardShape = async (scheduleId) => {
    const [row] = await q(
      `select s.status as schedule_status, p.status as plan_status
       from re_installment_schedule s join re_installment_plans p on p.id = s.plan_id
       where s.id = $1`, [scheduleId]);
    return row;
  };

  const waivedRow = await guardShape(waivedGuardSchedId);
  check('a waived schedule row is identifiable by the exact query the record route now runs before accepting a payment',
    waivedRow.schedule_status === 'waived');

  // A schedule row whose PLAN is superseded (the state restructureService
  // leaves an old plan's rows in) must also be identifiable, even where the
  // row itself is still nominally 'pending'.
  const [{ id: supersededPlanId }] = await q(
    `insert into re_installment_plans (organization_id, reservation_id, total_amount, number_of_installments, start_date, status)
     values ($1,$2,1000000,5,'2026-01-01','superseded') returning id`, [userId, reallocResB]);
  const [{ id: supersededSchedId }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due, status)
     values ($1,$2,1,'2026-01-01',500000,'pending') returning id`, [userId, supersededPlanId]);
  const supersededRow = await guardShape(supersededSchedId);
  check('a schedule row whose PLAN (not the row itself) is superseded is identifiable by the same query — the second half of the guard',
    supersededRow.plan_status === 'superseded' && supersededRow.schedule_status === 'pending');

  // ── Receipt for a voided payment must not be findable
  // (receiptService.js loadPaymentContext) ─────────────────────────────────
  const [{ id: voidReceiptSchedId }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,23,'2026-12-01',150000) returning id`, [userId, planId]);
  const [{ id: voidReceiptPaymentId }] = await q(
    `insert into re_payments (organization_id, schedule_id, amount, method) values ($1,$2,150000,'bank_transfer') returning id`,
    [userId, voidReceiptSchedId]);
  await q(`update re_payments set voided_at = now(), void_reason='test void' where id=$1`, [voidReceiptPaymentId]);

  let voidedPaymentFoundByReceiptLookup = true;
  try {
    const rows = await q(
      `select id from re_payments where id=$1 and organization_id=$2 and voided_at is null`,
      [voidReceiptPaymentId, userId]);
    voidedPaymentFoundByReceiptLookup = rows.length > 0;
  } catch (err) { console.log(`       ${err.message}`); }
  check('receiptService.loadPaymentContext\'s query (id + org + voided_at is null) does not find a voided payment',
    !voidedPaymentFoundByReceiptLookup);

  // ── Receipt superseded when its payment is voided (routes/payments.js
  // void route) — re_documents.status has no 'voided' value, so the fix
  // reuses 'pending' + clears storage_path, the two fields that gate
  // whether a receipt is servable everywhere else in the product. ─────────
  const [{ id: receiptDocId }] = await q(
    `insert into re_documents (organization_id, reservation_id, payment_id, doc_type, status, storage_path, generated_at)
     values ($1,$2,$3,'receipt','generated','org/receipts/doc-1/123.pdf', now()) returning id`,
    [userId, liveReservation, voidReceiptPaymentId]);

  let receiptSuperseded = false;
  try {
    const [row] = await q(
      `update re_documents set status='pending', storage_path=null, generated_at=null
       where organization_id=$1 and payment_id=$2 and doc_type='receipt' and status='generated'
       returning id`, [userId, voidReceiptPaymentId]);
    receiptSuperseded = Boolean(row);
  } catch (err) { console.log(`       ${err.message}`); }
  check('voiding a payment supersedes its already-generated receipt (status/storage_path cleared)', receiptSuperseded);

  const stillVisibleToPortal = await q(`select id from re_documents where id=$1 and status='generated'`, [receiptDocId]);
  check('the superseded receipt no longer matches portalService\'s status=generated buyer-visible filter', stillVisibleToPortal.length === 0);

  // ── Import rollback: hard-deleting an orphaned reservation frees its unit
  // (routes/imports.js, mirrors routes/reservations.js's own POST rollback) ─
  const [{ id: importRollbackProject }] = await q(
    `insert into re_projects (organization_id, name) values ($1,'Import Rollback Estate') returning id`, [userId]);
  const [{ id: importRollbackUnit }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price, status)
     values ($1,$2,'IMP-1',3000000,'reserved') returning id`, [userId, importRollbackProject]);
  const [{ id: importRollbackBuyer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Import Rollback Buyer') returning id`, [userId]);
  const [{ id: importRollbackRes }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3) returning id`,
    [userId, importRollbackUnit, importRollbackBuyer]);

  // Mirrors the exact rollback sequence imports.js now runs on a
  // plan-creation failure: hard-delete the reservation just created for
  // this row, release the unit.
  await q(`delete from re_reservations where id=$1`, [importRollbackRes]);
  await q(`update re_units set status='available' where id=$1 and organization_id=$2`, [importRollbackUnit, userId]);

  const [{ status: unitStatusAfterRollback }] = await q(`select status from re_units where id=$1`, [importRollbackUnit]);
  check('the import rollback sequence returns the unit to available', unitStatusAfterRollback === 'available');

  const [{ id: importRollbackBuyer2 }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Second Attempt Buyer') returning id`, [userId]);
  let unitReclaimable = true;
  try {
    await q(`insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3)`,
      [userId, importRollbackUnit, importRollbackBuyer2]);
  } catch (err) { unitReclaimable = false; console.log(`       ${err.message}`); }
  check('the unit is fully reclaimable by a later row after the rollback — no permanently stranded inventory', unitReclaimable);

  // ── Restructure rollback invariant: a failure AFTER the new plan is
  // created (e.g. the contract-value link update) must leave exactly one
  // ACTIVE plan again, not two (services/restructureService.js) ───────────
  const [{ id: rbProject }] = await q(
    `insert into re_projects (organization_id, name) values ($1,'Restructure Rollback Estate') returning id`, [userId]);
  const [{ id: rbUnit }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price) values ($1,$2,'RB-1',9000000) returning id`,
    [userId, rbProject]);
  const [{ id: rbBuyer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Restructure Rollback Buyer') returning id`, [userId]);
  const [{ id: rbRes }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3) returning id`,
    [userId, rbUnit, rbBuyer]);
  const [{ id: rbOldPlan }] = await q(
    `insert into re_installment_plans (organization_id, reservation_id, total_amount, number_of_installments, start_date, status)
     values ($1,$2,9000000,9,'2026-01-01','active') returning id`, [userId, rbRes]);
  const [{ id: rbSchedPending }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due, status)
     values ($1,$2,1,'2026-01-01',1000000,'pending') returning id`, [userId, rbOldPlan]);
  const [{ id: rbSchedOverdue }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due, status)
     values ($1,$2,2,'2026-02-01',1000000,'overdue') returning id`, [userId, rbOldPlan]);

  // Simulate what restructure() does BEFORE createPlanWithSchedule:
  // supersede the old plan, waive its unpaid rows.
  await q(`update re_installment_plans set status='superseded' where id=$1`, [rbOldPlan]);
  await q(`update re_installment_schedule set status='waived' where id in ($1,$2)`, [rbSchedPending, rbSchedOverdue]);

  // Simulate createPlanWithSchedule succeeding (the new plan + schedule
  // exist)...
  const [{ id: rbNewPlan }] = await q(
    `insert into re_installment_plans (organization_id, reservation_id, total_amount, number_of_installments, start_date, status)
     values ($1,$2,9000000,9,'2026-10-01','active') returning id`, [userId, rbRes]);
  const [{ id: rbNewSched }] = await q(
    `insert into re_installment_schedule (organization_id, plan_id, installment_number, due_date, amount_due)
     values ($1,$2,1,'2026-10-01',1000000) returning id`, [userId, rbNewPlan]);

  // ...then the LINK update (setting original_total_amount/carried_amount_paid)
  // fails — simulated by simply not running it; the failure itself is the
  // premise. This is the exact rollback restructureService.js's catch block
  // now runs in that case.
  await q(`delete from re_installment_schedule where plan_id=$1`, [rbNewPlan]);
  await q(`delete from re_installment_plans where id=$1`, [rbNewPlan]);
  await q(`update re_installment_plans set status='active', restructured_at=null, restructure_reason=null where id=$1`, [rbOldPlan]);
  await q(`update re_installment_schedule set status='pending' where id=$1`, [rbSchedPending]);
  await q(`update re_installment_schedule set status='overdue' where id=$1`, [rbSchedOverdue]);

  const activePlans = await q(`select id from re_installment_plans where reservation_id=$1 and status='active'`, [rbRes]);
  check('after the rollback, the reservation has exactly ONE active plan again (the restored original)',
    activePlans.length === 1 && activePlans[0].id === rbOldPlan);

  const restoredStatuses = await q(
    `select id, status from re_installment_schedule where plan_id=$1 order by installment_number`, [rbOldPlan]);
  check('each waived row is restored to its OWN prior status, not a blanket value',
    restoredStatuses[0].status === 'pending' && restoredStatuses[1].status === 'overdue');

  const newPlanGone = await q(`select id from re_installment_plans where id=$1`, [rbNewPlan]);
  check('the new plan (created seconds before the simulated failure) no longer exists after rollback', newPlanGone.length === 0);

  const newSchedGone = await q(`select id from re_installment_schedule where id=$1`, [rbNewSched]);
  check('the new plan\'s schedule rows are gone too', newSchedGone.length === 0);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err.message);
  process.exit(1);
});
