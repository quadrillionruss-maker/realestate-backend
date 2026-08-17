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
      '017_paystack_org_keys.sql', '018_resend_org_keys.sql', '019_termii_org_keys.sql', '020_commission_rate_snapshot.sql',
      '021_group_organizations.sql', '022_construction_milestones.sql', '023_credit_scoring.sql',
      '024_buyer_referrals.sql', '025_sales_forecasts.sql', '026_plan_recommendations.sql',
      '027_legal_documents_esignature.sql', '028_v2_agents.sql', '029_activities.sql', '030_hardship_requests.sql', '031_messages.sql', '032_unit_details.sql', '033_legal_cases.sql', '034_financing_requests.sql', '035_handover.sql', '036_contractors.sql', '037_community.sql', '038_project_health.sql', '039_admin.sql', '040_admin_actions.sql', '041_buyer_blacklist.sql', '042_document_expiry.sql', '043_document_versioning.sql', '044_email_templates.sql', '045_push_subscriptions.sql', '046_totp_2fa.sql', '047_sessions.sql', '048_receipt_templates.sql', '049_scheduled_messages.sql', '050_satisfaction_surveys.sql', '051_portal_notifications.sql', '052_subscriptions.sql', '053_feature_events.sql', '054_client_errors.sql']) {
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
      '017_paystack_org_keys.sql', '018_resend_org_keys.sql', '019_termii_org_keys.sql', '020_commission_rate_snapshot.sql',
      '021_group_organizations.sql', '022_construction_milestones.sql', '023_credit_scoring.sql',
      '024_buyer_referrals.sql', '025_sales_forecasts.sql', '026_plan_recommendations.sql',
      '027_legal_documents_esignature.sql', '028_v2_agents.sql', '029_activities.sql', '030_hardship_requests.sql', '031_messages.sql', '032_unit_details.sql', '033_legal_cases.sql', '034_financing_requests.sql', '035_handover.sql', '036_contractors.sql', '037_community.sql', '038_project_health.sql', '039_admin.sql', '040_admin_actions.sql', '041_buyer_blacklist.sql', '042_document_expiry.sql', '043_document_versioning.sql', '044_email_templates.sql', '045_push_subscriptions.sql', '046_totp_2fa.sql', '047_sessions.sql', '048_receipt_templates.sql', '049_scheduled_messages.sql', '050_satisfaction_surveys.sql', '051_portal_notifications.sql', '052_subscriptions.sql', '053_feature_events.sql', '054_client_errors.sql']) {
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
    're_org_settings', 're_commissions', 're_payment_promises', 're_audit_log', 're_notifications',
    'parent_organizations', 're_construction_milestones', 're_customer_referrals', 're_forecasts', 're_plan_recommendations', 're_document_templates',
    're_agent_actions', 're_market_intel_reports', 're_activities', 're_hardship_requests', 're_messages', 're_legal_cases', 're_financing_requests',
    're_handover_checklists', 're_snagging_items', 're_contractors', 're_contractor_payments',
    're_community_posts', 're_community_replies', 're_project_health', 're_cron_runs'];

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
    'parent_organizations', 're_construction_milestones', 're_customer_referrals', 're_forecasts', 're_plan_recommendations', 're_document_templates',
    're_agent_actions', 're_market_intel_reports', 're_activities', 're_hardship_requests', 're_messages', 're_legal_cases',
    're_financing_requests', 're_handover_checklists', 're_snagging_items', 're_contractors', 're_contractor_payments',
    're_community_posts', 're_community_replies', 're_project_health', 're_cron_runs', 're_admin_actions',
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

  // 005 recreates uniq_re_allocation_letter_per_reservation with its OWN
  // (narrower, pre-043) predicate — replaying 005 alone here, out of its
  // normal single-pass position, leaves that index in a shape no real
  // deployment could ever actually have (005 always runs once, followed by
  // every later migration, including 043's widening of this same index).
  // Replaying 043 right behind it restores the state a real migration run
  // always guarantees, for every check below this point.
  await db.exec(fs.readFileSync(`${M}/043_document_versioning.sql`, 'utf8'));

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

  // ── 021: parent organization layer (SECTION 1 — multi-branch) ───────────

  const teamCols021 = await colsOf('teams');
  check('teams has parent_organization_id', teamCols021.includes('parent_organization_id'), teamCols021.join(', '));

  const parentOrgCols = await colsOf('parent_organizations');
  check('parent_organizations has name and owner_id',
    ['name', 'owner_id'].every((c) => parentOrgCols.includes(c)), parentOrgCols.join(', '));

  const [{ id: groupOwnerId }] = await q(
    `insert into users (email, full_name) values ('group-owner@example.com','Group Owner') returning id`);
  const [{ id: groupId }] = await q(
    `insert into parent_organizations (name, owner_id) values ('Mshel Homes Group', $1) returning id`, [groupOwnerId]);
  const [{ id: branchTeamId }] = await q(
    `insert into teams (name, owner_id, parent_organization_id) values ('Mshel Abuja', $1, $2) returning id`,
    [groupOwnerId, groupId]);

  const branchLookup = await q(
    `select t.id, t.name, po.name as group_name from teams t
     join parent_organizations po on po.id = t.parent_organization_id
     where po.owner_id = $1`, [groupOwnerId]);
  check('a branch resolves back to its group and the group\'s owner, in one join',
    branchLookup.length === 1 && branchLookup[0].id === branchTeamId && branchLookup[0].group_name === 'Mshel Homes Group');

  // Deleting the group must not take the branch's own data down with it — a
  // branch is a real, independent workspace with its own buyers and
  // payments, not a row that only exists because the group does. Only the
  // roll-up link should clear.
  await q(`delete from parent_organizations where id=$1`, [groupId]);
  const [{ parent_organization_id: branchParentAfterGroupDelete }] = await q(
    `select parent_organization_id from teams where id=$1`, [branchTeamId]);
  check('deleting a group sets the branch\'s parent_organization_id to null rather than deleting the branch',
    branchParentAfterGroupDelete === null);
  const branchStillExists = await q(`select id from teams where id=$1`, [branchTeamId]);
  check('the branch workspace itself survives its group being deleted', branchStillExists.length === 1);

  // ── 022: construction milestones (SECTION 2) ─────────────────────────────

  const milestoneCols = await colsOf('re_construction_milestones');
  check('re_construction_milestones has the columns the app selects',
    ['project_id', 'name', 'target_date', 'completed_date', 'completion_percentage', 'photos', 'status', 'notified_at']
      .every((c) => milestoneCols.includes(c)),
    milestoneCols.join(', '));

  const [{ id: cmProject }] = await q(
    `insert into re_projects (organization_id, name) values ($1,'Milestone Test Estate') returning id`, [userId]);

  let unknownNameRefused = false;
  try {
    await q(`insert into re_construction_milestones (organization_id, project_id, name) values ($1,$2,'Landscaping')`,
      [userId, cmProject]);
  } catch (err) { unknownNameRefused = /check/i.test(err.message); }
  check('a milestone name outside the fixed five is refused', unknownNameRefused);

  const [{ id: cmMilestone }] = await q(
    `insert into re_construction_milestones (organization_id, project_id, name) values ($1,$2,'Foundation') returning id`,
    [userId, cmProject]);

  let duplicateMilestoneRefused = false;
  try {
    await q(`insert into re_construction_milestones (organization_id, project_id, name) values ($1,$2,'Foundation')`,
      [userId, cmProject]);
  } catch (err) { duplicateMilestoneRefused = /unique|duplicate/i.test(err.message); }
  check('a project cannot have two rows for the same milestone name', duplicateMilestoneRefused);

  // Eleven photos, one over the cap the product spec sets.
  const elevenPhotos = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ path: `p${i}`, url: `https://x/${i}` })));
  let elevenPhotosRefused = false;
  try {
    await q(`update re_construction_milestones set photos = $2::jsonb where id = $1`, [cmMilestone, elevenPhotos]);
  } catch (err) { elevenPhotosRefused = /check/i.test(err.message); }
  check('a milestone cannot hold more than 10 photos', elevenPhotosRefused);

  const tenPhotos = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ path: `p${i}`, url: `https://x/${i}` })));
  let tenPhotosAllowed = true;
  try {
    await q(`update re_construction_milestones set photos = $2::jsonb where id = $1`, [cmMilestone, tenPhotos]);
  } catch (err) { tenPhotosAllowed = false; console.log(`       ${err.message}`); }
  check('exactly 10 photos is still allowed', tenPhotosAllowed);

  let percentOutOfRangeRefused = false;
  try {
    await q(`update re_construction_milestones set completion_percentage = 150 where id = $1`, [cmMilestone]);
  } catch (err) { percentOutOfRangeRefused = /check/i.test(err.message); }
  check('completion_percentage over 100 is refused', percentOutOfRangeRefused);

  // ── 023: buyer credit scoring (SECTION 3) ────────────────────────────────

  const customerCols023 = await colsOf('re_customers');
  check('re_customers has credit_score', customerCols023.includes('credit_score'), customerCols023.join(', '));

  const [{ id: csCustomer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Credit Score Buyer') returning id`, [userId]);
  const [{ credit_score: defaultScore }] = await q(
    `select credit_score from re_customers where id=$1`, [csCustomer]);
  check('credit_score defaults to 100 for a freshly created buyer', defaultScore === 100);

  let creditScoreOutOfRangeRefused = false;
  try {
    await q(`update re_customers set credit_score = 101 where id=$1`, [csCustomer]);
  } catch (err) { creditScoreOutOfRangeRefused = /check/i.test(err.message); }
  check('credit_score over 100 is refused', creditScoreOutOfRangeRefused);

  let creditScoreNegativeRefused = false;
  try {
    await q(`update re_customers set credit_score = -1 where id=$1`, [csCustomer]);
  } catch (err) { creditScoreNegativeRefused = /check/i.test(err.message); }
  check('credit_score below 0 is refused', creditScoreNegativeRefused);

  const [{ ok: creditScoreIndexExists }] = await q(
    `select exists (select 1 from pg_indexes where indexname='idx_re_customers_credit_score') as ok`);
  check('idx_re_customers_credit_score exists', creditScoreIndexExists);

  // ── 024: buyer referral network (SECTION 5) ──────────────────────────────

  const referralCustomerCols = await colsOf('re_customers');
  check('re_customers has referral_code, referred_by_customer_id, referral_credit_balance',
    ['referral_code', 'referred_by_customer_id', 'referral_credit_balance'].every((c) => referralCustomerCols.includes(c)),
    referralCustomerCols.join(', '));

  const [{ id: refBuyerA }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Referral Buyer A') returning id`, [userId]);
  const [{ referral_code: refCodeA, referral_credit_balance: refBalanceA }] = await q(
    `select referral_code, referral_credit_balance from re_customers where id=$1`, [refBuyerA]);
  check('a new buyer gets an 8-character referral_code automatically', /^[A-Z0-9]{8}$/.test(refCodeA || ''), refCodeA);
  check('referral_credit_balance defaults to 0', Number(refBalanceA) === 0);

  let duplicateReferralCodeRefused = false;
  try {
    await q(`insert into re_customers (organization_id, full_name, referral_code) values ($1,'Dup Code Buyer',$2)`,
      [userId, refCodeA]);
  } catch (err) { duplicateReferralCodeRefused = /unique|duplicate/i.test(err.message); }
  check('referral_code is unique', duplicateReferralCodeRefused);

  const referralsTableCols = await colsOf('re_customer_referrals');
  check('re_customer_referrals has the columns the app selects',
    ['organization_id', 'referring_customer_id', 'referred_customer_id', 'status', 'reward_type', 'reward_amount', 'completed_at']
      .every((c) => referralsTableCols.includes(c)), referralsTableCols.join(', '));

  const [{ id: refBuyerB }] = await q(
    `insert into re_customers (organization_id, full_name, referred_by_customer_id) values ($1,'Referral Buyer B',$2) returning id`,
    [userId, refBuyerA]);
  const [{ id: referralRowId }] = await q(
    `insert into re_customer_referrals (organization_id, referring_customer_id, referred_customer_id) values ($1,$2,$3) returning id`,
    [userId, refBuyerA, refBuyerB]);

  let duplicateReferralRowRefused = false;
  try {
    await q(`insert into re_customer_referrals (organization_id, referring_customer_id, referred_customer_id) values ($1,$2,$3)`,
      [userId, refBuyerA, refBuyerB]);
  } catch (err) { duplicateReferralRowRefused = /unique|duplicate/i.test(err.message); }
  check('a referred buyer can only have one referral row (referred_customer_id is unique)', duplicateReferralRowRefused);

  let badReferralStatusRefused = false;
  try {
    await q(`update re_customer_referrals set status='bogus' where id=$1`, [referralRowId]);
  } catch (err) { badReferralStatusRefused = /check/i.test(err.message); }
  check('re_customer_referrals.status is constrained to pending|completed', badReferralStatusRefused);

  let badRewardTypeRefused = false;
  try {
    await q(`update re_customer_referrals set reward_type='bogus' where id=$1`, [referralRowId]);
  } catch (err) { badRewardTypeRefused = /check/i.test(err.message); }
  check('re_customer_referrals.reward_type is constrained to cash|credit', badRewardTypeRefused);

  const orgSettingsColsForReferrals = await colsOf('re_org_settings');
  check('re_org_settings has the WhatsApp credential columns',
    ['whatsapp_token_encrypted', 'whatsapp_token_last4', 'whatsapp_phone_number_id', 'whatsapp_business_account_id']
      .every((c) => orgSettingsColsForReferrals.includes(c)), orgSettingsColsForReferrals.join(', '));

  const [{ id: refSettingsOrgUser }] = await q(
    `insert into users (email, full_name) values ('ref-settings@example.com','Ref Settings User') returning id`);
  await q(`insert into re_org_settings (organization_id) values ($1)`, [refSettingsOrgUser]);
  const [{ referral_reward_type: defaultRewardType, referral_reward_amount: defaultRewardAmount }] = await q(
    `select referral_reward_type, referral_reward_amount from re_org_settings where organization_id=$1`, [refSettingsOrgUser]);
  check('referral_reward_type defaults to none', defaultRewardType === 'none');
  check('referral_reward_amount defaults to 0', Number(defaultRewardAmount) === 0);

  let badOrgRewardTypeRefused = false;
  try {
    await q(`update re_org_settings set referral_reward_type='bogus' where organization_id=$1`, [refSettingsOrgUser]);
  } catch (err) { badOrgRewardTypeRefused = /check/i.test(err.message); }
  check('re_org_settings.referral_reward_type is constrained to none|cash|credit', badOrgRewardTypeRefused);

  // ── 025: AI sales forecasting (SECTION 6) ────────────────────────────────

  const forecastCols = await colsOf('re_forecasts');
  check('re_forecasts has the columns the app selects',
    ['organization_id', 'generated_at', 'generated_by', 'payload'].every((c) => forecastCols.includes(c)),
    forecastCols.join(', '));

  const [{ id: forecastId }] = await q(
    `insert into re_forecasts (organization_id, generated_by, payload) values ($1,'fallback','{}'::jsonb) returning id`,
    [userId]);
  const [{ generated_by: storedGeneratedBy }] = await q(
    `select generated_by from re_forecasts where id=$1`, [forecastId]);
  check('a forecast row round-trips with its generated_by', storedGeneratedBy === 'fallback');

  let badForecastGeneratedByRefused = false;
  try {
    await q(`update re_forecasts set generated_by='bogus' where id=$1`, [forecastId]);
  } catch (err) { badForecastGeneratedByRefused = /check/i.test(err.message); }
  check('re_forecasts.generated_by is constrained to ai|fallback', badForecastGeneratedByRefused);

  const [{ ok: forecastIndexExists }] = await q(
    `select exists (select 1 from pg_indexes where indexname='idx_re_forecasts_org_generated') as ok`);
  check('idx_re_forecasts_org_generated exists', forecastIndexExists);

  // ── 026: smart payment plan AI (SECTION 7) ───────────────────────────────

  const planRecCols = await colsOf('re_plan_recommendations');
  check('re_plan_recommendations has the columns the app selects',
    ['customer_id', 'unit_id', 'requested_by_user_id', 'recommended_installments', 'recommended_deposit_percent',
      'recommended_frequency', 'reasoning', 'generated_by', 'accepted', 'reservation_id']
      .every((c) => planRecCols.includes(c)), planRecCols.join(', '));

  const [{ id: planRecCustomer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Plan Rec Buyer') returning id`, [userId]);
  const [{ id: planRecId }] = await q(
    `insert into re_plan_recommendations
       (organization_id, customer_id, recommended_installments, recommended_deposit_percent, recommended_frequency, generated_by)
     values ($1,$2,12,15.5,'monthly','fallback') returning id`,
    [userId, planRecCustomer]);
  const [{ accepted: planRecAcceptedDefault }] = await q(
    `select accepted from re_plan_recommendations where id=$1`, [planRecId]);
  check('accepted starts out null (not yet decided)', planRecAcceptedDefault === null);

  let badPlanRecFrequencyRefused = false;
  try {
    await q(`update re_plan_recommendations set recommended_frequency='fortnightly' where id=$1`, [planRecId]);
  } catch (err) { badPlanRecFrequencyRefused = /check/i.test(err.message); }
  check('re_plan_recommendations.recommended_frequency is constrained to monthly|quarterly', badPlanRecFrequencyRefused);

  let badPlanRecGeneratedByRefused = false;
  try {
    await q(`update re_plan_recommendations set generated_by='bogus' where id=$1`, [planRecId]);
  } catch (err) { badPlanRecGeneratedByRefused = /check/i.test(err.message); }
  check('re_plan_recommendations.generated_by is constrained to ai|fallback', badPlanRecGeneratedByRefused);

  // ── 027: legal document automation + e-signature (SECTION 8) ────────────

  const docCols027 = await colsOf('re_documents');
  check('re_documents has the e-signature columns',
    ['signed_at', 'signed_ip', 'signature_data', 'signature_type', 'signed_storage_path'].every((c) => docCols027.includes(c)),
    docCols027.join(', '));

  const [{ id: legalDocUnit }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price) values ($1,$2,'LEGAL-1',7000000) returning id`,
    [userId, cmProject]);
  const [{ id: legalDocCustomer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Legal Doc Buyer') returning id`, [userId]);
  const [{ id: legalDocReservation }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3) returning id`,
    [userId, legalDocUnit, legalDocCustomer]);

  let subscriberAgreementAccepted = true;
  try {
    await q(`insert into re_documents (organization_id, reservation_id, doc_type) values ($1,$2,'subscriber_agreement')`,
      [userId, legalDocReservation]);
  } catch (err) { subscriberAgreementAccepted = false; console.log(`       ${err.message}`); }
  check('subscriber_agreement is now an accepted doc_type', subscriberAgreementAccepted);

  const [{ id: poaDocId }] = await q(
    `insert into re_documents (organization_id, reservation_id, doc_type) values ($1,$2,'power_of_attorney') returning id`,
    [userId, legalDocReservation]);
  check('power_of_attorney is now an accepted doc_type', !!poaDocId);

  let unknownDocTypeStillRefused027 = false;
  try {
    await q(`insert into re_documents (organization_id, reservation_id, doc_type) values ($1,$2,'not_a_real_type')`,
      [userId, legalDocReservation]);
  } catch (err) { unknownDocTypeStillRefused027 = /check/i.test(err.message); }
  check('an unknown doc_type is still refused after the constraint was rebuilt', unknownDocTypeStillRefused027);

  let badSignatureTypeRefused = false;
  try {
    await q(`update re_documents set signature_type='scribbled' where id=$1`, [poaDocId]);
  } catch (err) { badSignatureTypeRefused = /check/i.test(err.message); }
  check('re_documents.signature_type is constrained to drawn|typed (or null)', badSignatureTypeRefused);

  let nullSignatureTypeStillAllowed = true;
  try {
    await q(`update re_documents set signature_type=null where id=$1`, [poaDocId]);
  } catch (err) { nullSignatureTypeStillAllowed = false; console.log(`       ${err.message}`); }
  check('signature_type can still be null (not yet signed)', nullSignatureTypeStillAllowed);

  const templateCols = await colsOf('re_document_templates');
  check('re_document_templates has the columns the app selects',
    ['organization_id', 'doc_type', 'template_html', 'updated_at'].every((c) => templateCols.includes(c)),
    templateCols.join(', '));

  const [{ id: templateId }] = await q(
    `insert into re_document_templates (organization_id, doc_type, template_html) values ($1,'deed_of_assignment','<p>custom</p>') returning id`,
    [userId]);
  check('a template override round-trips', !!templateId);

  let duplicateTemplateRefused = false;
  try {
    await q(`insert into re_document_templates (organization_id, doc_type, template_html) values ($1,'deed_of_assignment','<p>again</p>')`,
      [userId]);
  } catch (err) { duplicateTemplateRefused = /unique|duplicate/i.test(err.message); }
  check('only one template override per (organization_id, doc_type)', duplicateTemplateRefused);

  let badTemplateDocTypeRefused = false;
  try {
    await q(`insert into re_document_templates (organization_id, doc_type, template_html) values ($1,'receipt','<p>x</p>')`,
      [userId]);
  } catch (err) { badTemplateDocTypeRefused = /check/i.test(err.message); }
  check('re_document_templates.doc_type is limited to the three signable types', badTemplateDocTypeRefused);

  // ── 028: v2 AI agents + Deal Manager (SECTION 11) ────────────────────────

  const customerCols028 = await colsOf('re_customers');
  check('re_customers has whatsapp_opt_out', customerCols028.includes('whatsapp_opt_out'), customerCols028.join(', '));

  const reservationCols028 = await colsOf('re_reservations');
  check('re_reservations has last_agent_contact_at', reservationCols028.includes('last_agent_contact_at'), reservationCols028.join(', '));

  const orgSettingsCols028 = await colsOf('re_org_settings');
  check('re_org_settings has investor_emails', orgSettingsCols028.includes('investor_emails'), orgSettingsCols028.join(', '));

  const [{ id: agentActionCustomer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Agent Action Buyer') returning id`, [userId]);
  const [{ whatsapp_opt_out: optOutDefault }] = await q(
    `select whatsapp_opt_out from re_customers where id=$1`, [agentActionCustomer]);
  check('whatsapp_opt_out defaults to false', optOutDefault === false);

  const agentActionCols = await colsOf('re_agent_actions');
  check('re_agent_actions has the columns the app selects',
    ['organization_id', 'agent_name', 'customer_id', 'action_type', 'outcome', 'created_at'].every((c) => agentActionCols.includes(c)),
    agentActionCols.join(', '));

  const [{ id: agentActionId }] = await q(
    `insert into re_agent_actions (organization_id, agent_name, customer_id, action_type, outcome)
     values ($1,'collections_agent',$2,'collections_followup','sent') returning id`,
    [userId, agentActionCustomer]);
  check('an agent action round-trips', !!agentActionId);

  let badAgentNameRefused = false;
  try {
    await q(`update re_agent_actions set agent_name='not_a_real_agent' where id=$1`, [agentActionId]);
  } catch (err) { badAgentNameRefused = /check/i.test(err.message); }
  check('re_agent_actions.agent_name is limited to the six known agents', badAgentNameRefused);

  const marketIntelCols = await colsOf('re_market_intel_reports');
  check('re_market_intel_reports has the columns the app selects',
    ['organization_id', 'generated_at', 'payload'].every((c) => marketIntelCols.includes(c)), marketIntelCols.join(', '));

  const [{ id: marketIntelId }] = await q(
    `insert into re_market_intel_reports (organization_id, payload) values ($1,'{"summary":"x","signals":[]}'::jsonb) returning id`,
    [userId]);
  check('a market intel report round-trips', !!marketIntelId);

  // ── SECTION 2 — buyer activity log ───────────────────────────────────────
  const activityCols = await colsOf('re_activities');
  check('re_activities has the columns the app selects',
    ['organization_id', 'customer_id', 'logged_by_user_id', 'activity_type', 'notes', 'outcome', 'created_at', 'deleted_at']
      .every((c) => activityCols.includes(c)), activityCols.join(', '));

  const [{ id: activityCustomer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Activity Buyer') returning id`, [userId]);

  const [{ id: activityId }] = await q(
    `insert into re_activities (organization_id, customer_id, logged_by_user_id, activity_type, notes, outcome)
     values ($1,$2,$3,'call','Called to confirm next payment date','promised_payment') returning id`,
    [userId, activityCustomer, userId]);
  check('an activity round-trips', !!activityId);

  let emptyNotesRefused = false;
  try {
    await q(`insert into re_activities (organization_id, customer_id, activity_type, notes) values ($1,$2,'note','   ')`,
      [userId, activityCustomer]);
  } catch (err) { emptyNotesRefused = /check/i.test(err.message); }
  check('re_activities.notes cannot be blank', emptyNotesRefused);

  let badActivityTypeRefused = false;
  try {
    await q(`update re_activities set activity_type='phone_call' where id=$1`, [activityId]);
  } catch (err) { badActivityTypeRefused = /check/i.test(err.message); }
  check('re_activities.activity_type is limited to the six known types', badActivityTypeRefused);

  let badOutcomeRefused = false;
  try {
    await q(`update re_activities set outcome='maybe' where id=$1`, [activityId]);
  } catch (err) { badOutcomeRefused = /check/i.test(err.message); }
  check('re_activities.outcome is limited to the five known outcomes', badOutcomeRefused);

  // ── SECTION 4 — payment pause / hardship mode ────────────────────────────
  const hardshipCols = await colsOf('re_hardship_requests');
  check('re_hardship_requests has the columns the app selects',
    ['organization_id', 'reservation_id', 'customer_id', 'requested_by_portal', 'reason', 'status',
      'pause_months', 'reviewed_by', 'reviewed_at', 'applied_at', 'created_at']
      .every((c) => hardshipCols.includes(c)), hardshipCols.join(', '));

  const [{ id: hardshipUnit }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price)
     values ($1,$2,'H1',20000000) returning id`, [userId, projectId]);
  const [{ id: hardshipCustomer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Hardship Buyer') returning id`, [userId]);
  const [{ id: hardshipReservation }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3) returning id`,
    [userId, hardshipUnit, hardshipCustomer]);

  let shortReasonRefused = false;
  try {
    await q(
      `insert into re_hardship_requests (organization_id, reservation_id, customer_id, reason, pause_months)
       values ($1,$2,$3,'too short','1')`,
      [userId, hardshipReservation, hardshipCustomer]);
  } catch (err) { shortReasonRefused = /check/i.test(err.message); }
  check('re_hardship_requests.reason must be at least 20 characters', shortReasonRefused);

  let badMonthsRefused = false;
  try {
    await q(
      `insert into re_hardship_requests (organization_id, reservation_id, customer_id, reason, pause_months)
       values ($1,$2,$3,'Lost my job this month and need time',4)`,
      [userId, hardshipReservation, hardshipCustomer]);
  } catch (err) { badMonthsRefused = /check/i.test(err.message); }
  check('re_hardship_requests.pause_months is capped at 3', badMonthsRefused);

  const [{ id: hardshipId }] = await q(
    `insert into re_hardship_requests (organization_id, reservation_id, customer_id, reason, pause_months)
     values ($1,$2,$3,'Lost my job this month and need time',2) returning id`,
    [userId, hardshipReservation, hardshipCustomer]);
  check('a hardship request round-trips and defaults to pending', !!hardshipId);

  let secondPendingBlocked = false;
  try {
    await q(
      `insert into re_hardship_requests (organization_id, reservation_id, customer_id, reason, pause_months)
       values ($1,$2,$3,'A second request while the first is still pending',1)`,
      [userId, hardshipReservation, hardshipCustomer]);
  } catch (err) { secondPendingBlocked = /unique|duplicate/i.test(err.message); }
  check('only one PENDING hardship request per reservation', secondPendingBlocked);

  await q(`update re_hardship_requests set status='approved', reviewed_at=now(), applied_at=now() where id=$1`, [hardshipId]);

  let secondApprovedBlocked = false;
  try {
    await q(
      `insert into re_hardship_requests (organization_id, reservation_id, customer_id, reason, pause_months, status)
       values ($1,$2,$3,'Requesting hardship mode again after using it once already',1,'approved')`,
      [userId, hardshipReservation, hardshipCustomer]);
  } catch (err) { secondApprovedBlocked = /unique|duplicate/i.test(err.message); }
  check('a reservation can have at most one APPROVED hardship request, ever (once per reservation)', secondApprovedBlocked);

  // ── SECTION 5 — buyer/staff message thread ───────────────────────────────
  const messageCols = await colsOf('re_messages');
  check('re_messages has the columns the app selects',
    ['organization_id', 'customer_id', 'sender_type', 'sender_id', 'message', 'read_at', 'created_at']
      .every((c) => messageCols.includes(c)), messageCols.join(', '));

  const [{ id: buyerMessageId }] = await q(
    `insert into re_messages (organization_id, customer_id, sender_type, message) values ($1,$2,'buyer','When is my next payment due?') returning id`,
    [userId, hardshipCustomer]);
  check('a buyer message round-trips with no sender_id', !!buyerMessageId);

  const [{ id: staffMessageId }] = await q(
    `insert into re_messages (organization_id, customer_id, sender_type, sender_id, message) values ($1,$2,'staff',$3,'It is due on the 1st.') returning id`,
    [userId, hardshipCustomer, userId]);
  check('a staff message round-trips with its sender_id', !!staffMessageId);

  let buyerMessageWithSenderRefused = false;
  try {
    await q(`insert into re_messages (organization_id, customer_id, sender_type, sender_id, message) values ($1,$2,'buyer',$3,'x')`,
      [userId, hardshipCustomer, userId]);
  } catch (err) { buyerMessageWithSenderRefused = /check/i.test(err.message); }
  check('a buyer message cannot carry a sender_id', buyerMessageWithSenderRefused);

  let staffMessageWithoutSenderRefused = false;
  try {
    await q(`insert into re_messages (organization_id, customer_id, sender_type, message) values ($1,$2,'staff','x')`,
      [userId, hardshipCustomer]);
  } catch (err) { staffMessageWithoutSenderRefused = /check/i.test(err.message); }
  check('a staff message must carry a sender_id', staffMessageWithoutSenderRefused);

  let blankMessageRefused = false;
  try {
    await q(`insert into re_messages (organization_id, customer_id, sender_type, message) values ($1,$2,'buyer','   ')`,
      [userId, hardshipCustomer]);
  } catch (err) { blankMessageRefused = /check/i.test(err.message); }
  check('re_messages.message cannot be blank', blankMessageRefused);

  // ── SECTION 6 — rich unit profiles ────────────────────────────────────────
  const unitDetailCols = await colsOf('re_units');
  check('re_units has the new detail columns',
    ['description', 'bedrooms', 'bathrooms', 'parking_spaces', 'floor_level', 'furnishing_status']
      .every((c) => unitDetailCols.includes(c)), unitDetailCols.join(', '));

  const [{ furnishing_status: defaultFurnishing }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price) values ($1,$2,'DETAIL-1',10000000) returning furnishing_status`,
    [userId, projectId]);
  check('furnishing_status defaults to unfurnished', defaultFurnishing === 'unfurnished');

  let badFurnishingRefused = false;
  try {
    await q(`update re_units set furnishing_status='painted' where unit_number='DETAIL-1'`);
  } catch (err) { badFurnishingRefused = /check/i.test(err.message); }
  check('furnishing_status is limited to the three known states', badFurnishingRefused);

  let negativeBedroomsRefused = false;
  try {
    await q(`update re_units set bedrooms=-1 where unit_number='DETAIL-1'`);
  } catch (err) { negativeBedroomsRefused = /check/i.test(err.message); }
  check('bedrooms cannot be negative', negativeBedroomsRefused);

  await q(`update re_units set floor_level=0 where unit_number='DETAIL-1'`);
  const [{ floor_level: groundFloor }] = await q(`select floor_level from re_units where unit_number='DETAIL-1'`);
  check('floor_level of 0 (ground floor) is distinct from null (not yet recorded)', groundFloor === 0);

  // ── SECTION 8 — legal and recovery tracker ────────────────────────────────
  const legalCols = await colsOf('re_legal_cases');
  check('re_legal_cases has the columns the app selects',
    ['organization_id', 'customer_id', 'reservation_id', 'opened_by', 'status', 'lawyer_name', 'lawyer_phone',
      'lawyer_email', 'demand_letter_sent_at', 'court_dates', 'settlement_amount', 'settlement_date', 'notes',
      'created_at', 'updated_at']
      .every((c) => legalCols.includes(c)), legalCols.join(', '));

  const [{ id: legalCaseId }] = await q(
    `insert into re_legal_cases (organization_id, customer_id, reservation_id) values ($1,$2,$3) returning id`,
    [userId, hardshipCustomer, hardshipReservation]);
  check('a legal case round-trips and defaults to active with empty court_dates', !!legalCaseId);

  let secondActiveCaseBlocked = false;
  try {
    await q(`insert into re_legal_cases (organization_id, customer_id, reservation_id) values ($1,$2,$3)`,
      [userId, hardshipCustomer, hardshipReservation]);
  } catch (err) { secondActiveCaseBlocked = /unique|duplicate/i.test(err.message); }
  check('only one ACTIVE legal case per reservation at a time', secondActiveCaseBlocked);

  await q(`update re_legal_cases set status='settled' where id=$1`, [legalCaseId]);
  let freshCaseAfterSettlement = true;
  try {
    await q(`insert into re_legal_cases (organization_id, customer_id, reservation_id) values ($1,$2,$3)`,
      [userId, hardshipCustomer, hardshipReservation]);
  } catch (err) { freshCaseAfterSettlement = false; }
  check('a settled case does not block a fresh case being opened later', freshCaseAfterSettlement);

  let badLegalStatusRefused = false;
  try {
    await q(`update re_legal_cases set status='appealed' where id=$1`, [legalCaseId]);
  } catch (err) { badLegalStatusRefused = /check/i.test(err.message); }
  check('re_legal_cases.status is limited to the five known states', badLegalStatusRefused);

  const [{ id: demandLetterId }] = await q(
    `insert into re_documents (organization_id, reservation_id, doc_type, status) values ($1,$2,'demand_letter','generated') returning id`,
    [userId, hardshipReservation]);
  check('demand_letter is now an accepted re_documents doc_type', !!demandLetterId);

  // ── SECTION 9 — bank financing integration ────────────────────────────────
  const financingCols = await colsOf('re_financing_requests');
  check('re_financing_requests has the columns the app selects',
    ['organization_id', 'customer_id', 'reservation_id', 'bank_name', 'amount_requested', 'status',
      'submitted_at', 'bank_reference', 'notes', 'created_at']
      .every((c) => financingCols.includes(c)), financingCols.join(', '));

  const [{ id: financingId }] = await q(
    `insert into re_financing_requests (organization_id, customer_id, reservation_id, bank_name, amount_requested)
     values ($1,$2,$3,'GTBank',15000000) returning id`,
    [userId, hardshipCustomer, hardshipReservation]);
  check('a financing request round-trips and defaults to pending', !!financingId);

  let zeroAmountRefused = false;
  try {
    await q(`insert into re_financing_requests (organization_id, customer_id, reservation_id, bank_name, amount_requested)
             values ($1,$2,$3,'GTBank',0)`, [userId, hardshipCustomer, hardshipReservation]);
  } catch (err) { zeroAmountRefused = /check/i.test(err.message); }
  check('re_financing_requests.amount_requested must be positive', zeroAmountRefused);

  let badFinancingStatusRefused = false;
  try {
    await q(`update re_financing_requests set status='cancelled' where id=$1`, [financingId]);
  } catch (err) { badFinancingStatusRefused = /check/i.test(err.message); }
  check('re_financing_requests.status is limited to the six known states', badFinancingStatusRefused);

  const [{ id: financingLetterId }] = await q(
    `insert into re_documents (organization_id, reservation_id, doc_type, status) values ($1,$2,'financing_letter','generated') returning id`,
    [userId, hardshipReservation]);
  check('financing_letter is now an accepted re_documents doc_type', !!financingLetterId);

  // ── SECTION 11 — handover checklist and snagging ──────────────────────────
  const handoverCols = await colsOf('re_handover_checklists');
  check('re_handover_checklists has the columns the app selects',
    ['organization_id', 'reservation_id', 'created_by', 'status', 'handover_date', 'keys_handed',
      'meter_readings', 'documents_provided', 'created_at']
      .every((c) => handoverCols.includes(c)), handoverCols.join(', '));

  const snaggingCols = await colsOf('re_snagging_items');
  check('re_snagging_items has the columns the app selects',
    ['checklist_id', 'organization_id', 'description', 'photo_url', 'status', 'developer_response',
      'fix_committed_date', 'fixed_at', 'created_at']
      .every((c) => snaggingCols.includes(c)), snaggingCols.join(', '));

  const [{ id: handoverUnit }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price) values ($1,$2,'HANDOVER-1',30000000) returning id`,
    [userId, projectId]);
  const [{ id: handoverCustomer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Handover Buyer') returning id`, [userId]);
  const [{ id: handoverReservation }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3) returning id`,
    [userId, handoverUnit, handoverCustomer]);

  const [{ id: checklistId }] = await q(
    `insert into re_handover_checklists (organization_id, reservation_id) values ($1,$2) returning id`,
    [userId, handoverReservation]);
  check('a handover checklist round-trips and defaults to pending, keys not handed', !!checklistId);

  let secondChecklistBlocked = false;
  try {
    await q(`insert into re_handover_checklists (organization_id, reservation_id) values ($1,$2)`,
      [userId, handoverReservation]);
  } catch (err) { secondChecklistBlocked = /unique|duplicate/i.test(err.message); }
  check('only one handover checklist per reservation', secondChecklistBlocked);

  const [{ id: snagId }] = await q(
    `insert into re_snagging_items (checklist_id, organization_id, description) values ($1,$2,'Kitchen tap is leaking') returning id`,
    [checklistId, userId]);
  check('a snagging item round-trips and defaults to open', !!snagId);

  let blankSnagRefused = false;
  try {
    await q(`insert into re_snagging_items (checklist_id, organization_id, description) values ($1,$2,'   ')`,
      [checklistId, userId]);
  } catch (err) { blankSnagRefused = /check/i.test(err.message); }
  check('re_snagging_items.description cannot be blank', blankSnagRefused);

  let badSnagStatusRefused = false;
  try {
    await q(`update re_snagging_items set status='ignored' where id=$1`, [snagId]);
  } catch (err) { badSnagStatusRefused = /check/i.test(err.message); }
  check('re_snagging_items.status is limited to the four known states', badSnagStatusRefused);

  const [{ id: handoverCertId }] = await q(
    `insert into re_documents (organization_id, reservation_id, doc_type, status) values ($1,$2,'handover_certificate','generated') returning id`,
    [userId, handoverReservation]);
  check('handover_certificate is now an accepted re_documents doc_type', !!handoverCertId);

  // ── SECTION 12 — contractor and supplier payment tracking ────────────────
  const contractorCols = await colsOf('re_contractors');
  check('re_contractors has the columns the app selects',
    ['organization_id', 'project_id', 'name', 'type', 'phone', 'email', 'created_at']
      .every((c) => contractorCols.includes(c)), contractorCols.join(', '));

  const contractorPaymentCols = await colsOf('re_contractor_payments');
  check('re_contractor_payments has the columns the app selects',
    ['organization_id', 'contractor_id', 'project_id', 'milestone_id', 'amount', 'due_date', 'paid_date',
      'status', 'description', 'created_at']
      .every((c) => contractorPaymentCols.includes(c)), contractorPaymentCols.join(', '));

  const [{ id: contractorId }] = await q(
    `insert into re_contractors (organization_id, project_id, name, type) values ($1,$2,'ABC Roofing Ltd','roofing') returning id`,
    [userId, projectId]);
  check('a contractor round-trips', !!contractorId);

  let badContractorTypeRefused = false;
  try {
    await q(`insert into re_contractors (organization_id, project_id, name, type) values ($1,$2,'X','painting')`,
      [userId, projectId]);
  } catch (err) { badContractorTypeRefused = /check/i.test(err.message); }
  check('re_contractors.type is limited to the seven known trades', badContractorTypeRefused);

  const [{ id: contractorPaymentId }] = await q(
    `insert into re_contractor_payments (organization_id, contractor_id, project_id, amount, due_date)
     values ($1,$2,$3,15000000,'2026-09-15') returning id`,
    [userId, contractorId, projectId]);
  check('a contractor payment round-trips and defaults to pending', !!contractorPaymentId);

  let negativeContractorAmountRefused = false;
  try {
    await q(`insert into re_contractor_payments (organization_id, contractor_id, project_id, amount, due_date)
             values ($1,$2,$3,0,'2026-09-15')`, [userId, contractorId, projectId]);
  } catch (err) { negativeContractorAmountRefused = /check/i.test(err.message); }
  check('re_contractor_payments.amount must be positive', negativeContractorAmountRefused);

  // ── SECTION 13 — buyer community forum ────────────────────────────────────
  const postCols = await colsOf('re_community_posts');
  check('re_community_posts has the columns the app selects',
    ['organization_id', 'project_id', 'customer_id', 'content', 'pinned', 'moderated', 'created_at', 'deleted_at']
      .every((c) => postCols.includes(c)), postCols.join(', '));

  const replyCols = await colsOf('re_community_replies');
  check('re_community_replies has the columns the app selects',
    ['post_id', 'organization_id', 'customer_id', 'content', 'created_at', 'deleted_at']
      .every((c) => replyCols.includes(c)), replyCols.join(', '));

  const [{ id: postId }] = await q(
    `insert into re_community_posts (organization_id, project_id, customer_id, content) values ($1,$2,$3,'Anyone else moved in yet?') returning id`,
    [userId, projectId, hardshipCustomer]);
  check('a community post round-trips and defaults to unpinned, unmoderated', !!postId);

  let overlongPostRefused = false;
  try {
    await q(`insert into re_community_posts (organization_id, project_id, customer_id, content) values ($1,$2,$3,$4)`,
      [userId, projectId, hardshipCustomer, 'x'.repeat(501)]);
  } catch (err) { overlongPostRefused = /check/i.test(err.message); }
  check('re_community_posts.content is capped at 500 characters', overlongPostRefused);

  const [{ id: replyId }] = await q(
    `insert into re_community_replies (post_id, organization_id, customer_id, content) values ($1,$2,$3,'Yes, last week!') returning id`,
    [postId, userId, hardshipCustomer]);
  check('a community reply round-trips', !!replyId);

  let overlongReplyRefused = false;
  try {
    await q(`insert into re_community_replies (post_id, organization_id, customer_id, content) values ($1,$2,$3,$4)`,
      [postId, userId, hardshipCustomer, 'x'.repeat(301)]);
  } catch (err) { overlongReplyRefused = /check/i.test(err.message); }
  check('re_community_replies.content is capped at 300 characters', overlongReplyRefused);

  // ── SECTION 15 — abandoned project early warning system ──────────────────
  const healthCols = await colsOf('re_project_health');
  check('re_project_health has the columns the app selects',
    ['organization_id', 'project_id', 'health_score', 'signals', 'computed_date', 'computed_at']
      .every((c) => healthCols.includes(c)), healthCols.join(', '));

  const [{ id: healthId }] = await q(
    `insert into re_project_health (organization_id, project_id, health_score) values ($1,$2,55) returning id`,
    [userId, projectId]);
  check('a project health row round-trips', !!healthId);

  let secondSameDayBlocked = false;
  try {
    await q(`insert into re_project_health (organization_id, project_id, health_score) values ($1,$2,40)`,
      [userId, projectId]);
  } catch (err) { secondSameDayBlocked = /unique|duplicate/i.test(err.message); }
  check('only one health row per project per calendar day', secondSameDayBlocked);

  let outOfRangeScoreRefused = false;
  try {
    await q(`insert into re_project_health (organization_id, project_id, health_score, computed_date) values ($1,$2,101,'2026-01-01')`,
      [userId, projectId]);
  } catch (err) { outOfRangeScoreRefused = /check/i.test(err.message); }
  check('health_score is constrained to 0-100', outOfRangeScoreRefused);

  // ── Admin dashboard (migrations/039) ─────────────────────────────────────
  const cronCols = await colsOf('re_cron_runs');
  check('re_cron_runs has the columns the app selects',
    ['job_name', 'started_at', 'finished_at', 'orgs_processed', 'errors', 'created_at']
      .every((c) => cronCols.includes(c)), cronCols.join(', '));

  const [{ id: cronRunId }] = await q(
    `insert into re_cron_runs (job_name) values ('daily_brief') returning id`);
  check('a cron run round-trips and starts unfinished', !!cronRunId);

  const [{ finished_at: stillRunning }] = await q(
    `select finished_at from re_cron_runs where id = $1`, [cronRunId]);
  check('a fresh cron run has no finished_at', stillRunning === null);

  await q(`update re_cron_runs set finished_at = now(), orgs_processed = 3 where id = $1`, [cronRunId]);
  const [{ orgs_processed: orgsProcessed }] = await q(
    `select orgs_processed from re_cron_runs where id = $1`, [cronRunId]);
  check('a cron run records how many orgs it processed once finished', orgsProcessed === 3);

  // ── 041: buyer blacklist (SECTION 7) ─────────────────────────────────────
  const customerCols041 = await colsOf('re_customers');
  check('re_customers has the blacklist columns',
    ['blacklisted', 'blacklist_reason', 'blacklisted_at', 'blacklisted_by'].every((c) => customerCols041.includes(c)),
    customerCols041.join(', '));

  const [{ id: blacklistFixtureId }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Blacklist Fixture Buyer') returning id`, [userId]);
  const [{ blacklisted: blacklistedDefault }] = await q(
    `select blacklisted from re_customers where id=$1`, [blacklistFixtureId]);
  check('blacklisted defaults to false', blacklistedDefault === false);

  await q(
    `update re_customers set blacklisted = true, blacklist_reason = 'chargeback fraud', blacklisted_at = now() where id = $1`,
    [blacklistFixtureId]);
  const [{ blacklisted: blacklistedAfter, blacklist_reason: reasonAfter }] = await q(
    `select blacklisted, blacklist_reason from re_customers where id=$1`, [blacklistFixtureId]);
  check('a buyer can be blacklisted with a reason', blacklistedAfter === true && reasonAfter === 'chargeback fraud');

  // ── 042/043: document expiry + version history (SECTIONS 9/10) ──────────
  const docCols042 = await colsOf('re_documents');
  check('re_documents has the expiry and version-history columns',
    ['expires_at', 'version', 'superseded_at', 'superseded_by'].every((c) => docCols042.includes(c)),
    docCols042.join(', '));

  const [{ id: docVerProject }] = await q(
    `insert into re_projects (organization_id, name, total_units) values ($1,'Doc Version Estate',1) returning id`, [userId]);
  const [{ id: docVerUnit }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price) values ($1,$2,'DOCVER-1',5000000) returning id`,
    [userId, docVerProject]);
  const [{ id: docVerCustomer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Doc Version Buyer') returning id`, [userId]);
  const [{ id: docVerReservation }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3) returning id`,
    [userId, docVerUnit, docVerCustomer]);

  const [{ id: docV1 }] = await q(
    `insert into re_documents (organization_id, reservation_id, doc_type, status, expires_at)
     values ($1,$2,'allocation_letter','generated', now() + interval '90 days') returning id`,
    [userId, docVerReservation]);
  const [{ version: v1Version }] = await q(`select version from re_documents where id=$1`, [docV1]);
  check('re_documents.version defaults to 1', v1Version === 1);

  // Supersede v1 and insert v2 — the exact two-step writeGeneratedVersion
  // does, and the case the widened unique index (migrations/043) exists to
  // allow: one superseded row and one live row for the same reservation +
  // doc_type coexisting without a 23505.
  await q(`update re_documents set status='superseded', superseded_at=now() where id=$1`, [docV1]);
  let secondLiveAllocationLetterAllowed = true;
  let docV2 = null;
  try {
    const [{ id }] = await q(
      `insert into re_documents (organization_id, reservation_id, doc_type, status, version, expires_at)
       values ($1,$2,'allocation_letter','generated',2, now() + interval '90 days') returning id`,
      [userId, docVerReservation]);
    docV2 = id;
  } catch (err) { secondLiveAllocationLetterAllowed = false; console.log(`       ${err.message}`); }
  check('a superseded allocation letter and its live replacement can coexist', secondLiveAllocationLetterAllowed);

  await q(`update re_documents set superseded_by=$1 where id=$2`, [docV2, docV1]);
  const [{ superseded_by: supersededByLink }] = await q(`select superseded_by from re_documents where id=$1`, [docV1]);
  check('the old version links forward to the one that replaced it', supersededByLink === docV2);

  // The invariant itself must still hold: TWO LIVE (non-superseded)
  // allocation letters for one reservation is still refused, exactly as
  // before 043 — only "superseded" rows are exempt from the count.
  let secondLiveWithoutSupersedingRefused = false;
  try {
    await q(
      `insert into re_documents (organization_id, reservation_id, doc_type, status, version)
       values ($1,$2,'allocation_letter','generated',3)`,
      [userId, docVerReservation]);
  } catch (err) { secondLiveWithoutSupersedingRefused = /unique|duplicate/i.test(err.message); }
  check('two LIVE allocation letters for one reservation is still refused — only a superseded one may coexist',
    secondLiveWithoutSupersedingRefused);

  let badStatusStillRefused = false;
  try {
    await q(`update re_documents set status='not_a_real_status' where id=$1`, [docV2]);
  } catch (err) { badStatusStillRefused = /check/i.test(err.message); }
  check('an unknown re_documents.status is still refused after the constraint was widened for "superseded"', badStatusStillRefused);

  // ── 044: customizable email templates (SECTION 14) ───────────────────────
  const emailTemplateCols = await colsOf('re_email_templates');
  check('re_email_templates has the columns the app selects',
    ['organization_id', 'template_type', 'subject', 'body_html', 'created_at', 'updated_at']
      .every((c) => emailTemplateCols.includes(c)), emailTemplateCols.join(', '));

  const [{ id: emailTemplateId }] = await q(
    `insert into re_email_templates (organization_id, template_type, subject, body_html)
     values ($1,'receipt','Your receipt from {{buyer_name}}','<p>Thanks for {{amount}}</p>') returning id`,
    [userId]);
  check('an email template round-trips', !!emailTemplateId);

  let badTemplateTypeRefused = false;
  try {
    await q(`insert into re_email_templates (organization_id, template_type, subject, body_html)
             values ($1,'not_a_real_type','x','y')`, [userId]);
  } catch (err) { badTemplateTypeRefused = /check/i.test(err.message); }
  check('re_email_templates.template_type is limited to the five known types', badTemplateTypeRefused);

  let duplicateTemplateTypeRefused = false;
  try {
    await q(`insert into re_email_templates (organization_id, template_type, subject, body_html)
             values ($1,'receipt','again','again')`, [userId]);
  } catch (err) { duplicateTemplateTypeRefused = /unique|duplicate/i.test(err.message); }
  check('only one template per (organization_id, template_type)', duplicateTemplateTypeRefused);

  let oversizedBodyRefused = false;
  try {
    await q(`insert into re_email_templates (organization_id, template_type, subject, body_html)
             values ($1,'welcome','x',$2)`, [userId, 'x'.repeat(5001)]);
  } catch (err) { oversizedBodyRefused = /check/i.test(err.message); }
  check('re_email_templates.body_html is capped at 5000 characters', oversizedBodyRefused);

  // ── 045: push notifications (SECTION 1) ──────────────────────────────────
  const pushSubCols = await colsOf('re_push_subscriptions');
  check('re_push_subscriptions has the columns the app selects',
    ['user_id', 'organization_id', 'endpoint', 'p256dh', 'auth', 'created_at'].every((c) => pushSubCols.includes(c)),
    pushSubCols.join(', '));

  const pushNotifCols = await colsOf('re_push_notifications');
  check('re_push_notifications has the columns the app selects',
    ['user_id', 'organization_id', 'title', 'body', 'url', 'created_at', 'read_at'].every((c) => pushNotifCols.includes(c)),
    pushNotifCols.join(', '));

  const [{ id: pushSubId }] = await q(
    `insert into re_push_subscriptions (user_id, organization_id, endpoint, p256dh, auth)
     values ($1,$2,'https://fcm.googleapis.com/fcm/send/abc123','p256dh-key','auth-key') returning id`,
    [userId, userId]);
  check('a push subscription round-trips', !!pushSubId);

  let duplicateEndpointRefused = false;
  try {
    await q(`insert into re_push_subscriptions (user_id, organization_id, endpoint, p256dh, auth)
             values ($1,$2,'https://fcm.googleapis.com/fcm/send/abc123','x','y')`, [userId, userId]);
  } catch (err) { duplicateEndpointRefused = /unique|duplicate/i.test(err.message); }
  check('re_push_subscriptions.endpoint is unique — the same browser subscription is not stored twice', duplicateEndpointRefused);

  const [{ id: pushNotifId }] = await q(
    `insert into re_push_notifications (user_id, organization_id, title, body, url)
     values ($1,$2,'Payment received','₦500,000 from Test Buyer','/#/payments') returning id`,
    [userId, userId]);
  const [{ read_at: pushNotifReadAtDefault }] = await q(`select read_at from re_push_notifications where id=$1`, [pushNotifId]);
  check('a push notification round-trips and starts unread', pushNotifReadAtDefault === null);

  // ── 046: TOTP 2FA (SECTION 2) ─────────────────────────────────────────────
  const totpCols = await colsOf('users');
  check('users has the 2FA columns',
    ['totp_secret_encrypted', 'totp_enabled', 'totp_backup_codes'].every((c) => totpCols.includes(c)),
    totpCols.join(', '));

  const [{ totp_enabled: totpEnabledDefault, totp_backup_codes: totpBackupCodesDefault }] = await q(
    `select totp_enabled, totp_backup_codes from users where id=$1`, [userId]);
  check('totp_enabled defaults to false', totpEnabledDefault === false);
  check('totp_backup_codes defaults to an empty array', Array.isArray(totpBackupCodesDefault) && totpBackupCodesDefault.length === 0);

  // ── 047: sessions (SECTION 3) ─────────────────────────────────────────────
  const sessionCols = await colsOf('re_sessions');
  check('re_sessions has the columns the app selects',
    ['user_id', 'organization_id', 'token_hash', 'device_info', 'ip_address', 'created_at', 'last_used_at', 'revoked_at']
      .every((c) => sessionCols.includes(c)), sessionCols.join(', '));

  const [{ id: sessionId }] = await q(
    `insert into re_sessions (user_id, organization_id, token_hash, device_info, ip_address)
     values ($1,$2,'fakehash123','Chrome on Windows','127.0.0.1') returning id`,
    [userId, userId]);
  const [{ revoked_at: sessionRevokedDefault }] = await q(`select revoked_at from re_sessions where id=$1`, [sessionId]);
  check('a session round-trips and starts unrevoked', sessionRevokedDefault === null);

  let duplicateTokenHashRefused = false;
  try {
    await q(`insert into re_sessions (user_id, organization_id, token_hash) values ($1,$2,'fakehash123')`, [userId, userId]);
  } catch (err) { duplicateTokenHashRefused = /unique|duplicate/i.test(err.message); }
  check('re_sessions.token_hash is unique — the same token is not tracked as two sessions', duplicateTokenHashRefused);

  await q(`update re_sessions set revoked_at = now() where id = $1`, [sessionId]);
  const [{ revoked_at: sessionRevokedAfter }] = await q(`select revoked_at from re_sessions where id=$1`, [sessionId]);
  check('a session can be revoked', sessionRevokedAfter !== null);

  // ── 048: receipt template customization (SECTION 5) ─────────────────────
  const receiptTemplateCols = await colsOf('re_receipt_templates');
  check('re_receipt_templates has the columns the app selects',
    ['organization_id', 'header_html', 'footer_html', 'show_logo', 'show_developer_address', 'created_at', 'updated_at']
      .every((c) => receiptTemplateCols.includes(c)), receiptTemplateCols.join(', '));

  const [{ show_logo: receiptShowLogoDefault, show_developer_address: receiptShowAddressDefault }] = await q(
    `insert into re_receipt_templates (organization_id, header_html, footer_html)
     values ($1,'<b>My Letterhead</b>','Queries: accounts@example.com')
     returning show_logo, show_developer_address`,
    [userId]);
  check('show_logo and show_developer_address default to true', receiptShowLogoDefault === true && receiptShowAddressDefault === true);

  let secondReceiptTemplateForSameOrgRefused = false;
  try {
    await q(`insert into re_receipt_templates (organization_id) values ($1)`, [userId]);
  } catch (err) { secondReceiptTemplateForSameOrgRefused = /unique|duplicate/i.test(err.message); }
  check('only one receipt template per organization', secondReceiptTemplateForSameOrgRefused);

  const [{ id: receiptTemplateFixtureUserId }] = await q(
    `insert into users (email, full_name) values ('receipt-template-fixture@example.com','Receipt Template Fixture') returning id`);
  let oversizedHeaderRefused = false;
  try {
    await q(`insert into re_receipt_templates (organization_id, header_html) values ($1, $2)`,
      [receiptTemplateFixtureUserId, 'x'.repeat(2001)]);
  } catch (err) { oversizedHeaderRefused = /check/i.test(err.message); }
  check('re_receipt_templates.header_html is capped at 2000 characters', oversizedHeaderRefused);

  // ── 049: scheduled WhatsApp messages (SECTION 16) ────────────────────────
  const scheduledMsgCols = await colsOf('re_scheduled_messages');
  check('re_scheduled_messages has the columns the app selects',
    ['organization_id', 'customer_id', 'message', 'scheduled_for', 'sent_at', 'status', 'created_by', 'created_at']
      .every((c) => scheduledMsgCols.includes(c)), scheduledMsgCols.join(', '));

  const [{ id: scheduledMsgCustomer }] = await q(
    `insert into re_customers (organization_id, full_name, phone) values ($1,'Scheduled Msg Buyer','08031234567') returning id`, [userId]);
  const [{ id: scheduledMsgId, status: scheduledMsgStatusDefault }] = await q(
    `insert into re_scheduled_messages (organization_id, customer_id, message, scheduled_for, created_by)
     values ($1,$2,'Hi, reminder about your installment', now() + interval '1 day', $1) returning id, status`,
    [userId, scheduledMsgCustomer]);
  check('a scheduled message round-trips and defaults to pending', scheduledMsgStatusDefault === 'pending');

  let blankScheduledMessageRefused = false;
  try {
    await q(`insert into re_scheduled_messages (organization_id, customer_id, message, scheduled_for) values ($1,$2,'',now())`,
      [userId, scheduledMsgCustomer]);
  } catch (err) { blankScheduledMessageRefused = /check/i.test(err.message); }
  check('re_scheduled_messages.message cannot be blank', blankScheduledMessageRefused);

  let badScheduledStatusRefused = false;
  try {
    await q(`update re_scheduled_messages set status='not_a_real_status' where id=$1`, [scheduledMsgId]);
  } catch (err) { badScheduledStatusRefused = /check/i.test(err.message); }
  check('re_scheduled_messages.status is limited to the four known states', badScheduledStatusRefused);

  await q(`update re_scheduled_messages set status='cancelled' where id=$1`, [scheduledMsgId]);
  const [{ status: scheduledMsgCancelled }] = await q(`select status from re_scheduled_messages where id=$1`, [scheduledMsgId]);
  check('a scheduled message can be cancelled', scheduledMsgCancelled === 'cancelled');

  // ── 050: satisfaction surveys (SECTION 18) ───────────────────────────────
  const surveyCols = await colsOf('re_satisfaction_surveys');
  check('re_satisfaction_surveys has the columns the app selects',
    ['organization_id', 'reservation_id', 'customer_id', 'sent_at', 'completed_at',
      'overall_score', 'construction_quality_score', 'sales_experience_score', 'comments']
      .every((c) => surveyCols.includes(c)), surveyCols.join(', '));

  const [{ id: surveyUnit }] = await q(
    `insert into re_units (organization_id, project_id, unit_number, list_price) values ($1,$2,'SURVEY-1',6000000) returning id`,
    [userId, docVerProject]);
  const [{ id: surveyCustomer }] = await q(
    `insert into re_customers (organization_id, full_name) values ($1,'Survey Buyer') returning id`, [userId]);
  const [{ id: surveyReservation }] = await q(
    `insert into re_reservations (organization_id, unit_id, customer_id) values ($1,$2,$3) returning id`,
    [userId, surveyUnit, surveyCustomer]);

  const [{ id: surveyId, completed_at: surveyCompletedAtDefault }] = await q(
    `insert into re_satisfaction_surveys (organization_id, reservation_id, customer_id) values ($1,$2,$3) returning id, completed_at`,
    [userId, surveyReservation, surveyCustomer]);
  check('a satisfaction survey round-trips and starts uncompleted', surveyCompletedAtDefault === null);

  let secondSurveyForSameReservationRefused = false;
  try {
    await q(`insert into re_satisfaction_surveys (organization_id, reservation_id, customer_id) values ($1,$2,$3)`,
      [userId, surveyReservation, surveyCustomer]);
  } catch (err) { secondSurveyForSameReservationRefused = /unique|duplicate/i.test(err.message); }
  check('only one satisfaction survey per reservation', secondSurveyForSameReservationRefused);

  let outOfRangeSurveyScoreRefused = false;
  try {
    await q(`update re_satisfaction_surveys set overall_score = 7 where id = $1`, [surveyId]);
  } catch (err) { outOfRangeSurveyScoreRefused = /check/i.test(err.message); }
  check('re_satisfaction_surveys scores are constrained to 1-5', outOfRangeSurveyScoreRefused);

  await q(`update re_satisfaction_surveys set overall_score = 5, completed_at = now() where id = $1`, [surveyId]);
  const [{ overall_score: surveyScoreAfter }] = await q(`select overall_score from re_satisfaction_surveys where id=$1`, [surveyId]);
  check('a satisfaction survey can be completed with a score', surveyScoreAfter === 5);

  // ── 051: portal notification bell (SECTION 20) ───────────────────────────
  const portalNotifCols = await colsOf('re_portal_notifications');
  check('re_portal_notifications has the columns the app selects',
    ['organization_id', 'customer_id', 'type', 'title', 'body', 'read_at', 'created_at']
      .every((c) => portalNotifCols.includes(c)), portalNotifCols.join(', '));

  const [{ id: portalNotifId, read_at: portalNotifReadAtDefault }] = await q(
    `insert into re_portal_notifications (organization_id, customer_id, type, title, body)
     values ($1,$2,'payment_recorded','Payment received','We received ₦500,000') returning id, read_at`,
    [userId, surveyCustomer]);
  check('a portal notification round-trips and starts unread', portalNotifReadAtDefault === null);

  let badPortalNotifTypeRefused = false;
  try {
    await q(`insert into re_portal_notifications (organization_id, customer_id, type, title) values ($1,$2,'not_a_real_type','x')`,
      [userId, surveyCustomer]);
  } catch (err) { badPortalNotifTypeRefused = /check/i.test(err.message); }
  check('re_portal_notifications.type is limited to the five known types', badPortalNotifTypeRefused);

  await q(`update re_portal_notifications set read_at = now() where id = $1`, [portalNotifId]);
  const [{ read_at: portalNotifReadAtAfter }] = await q(`select read_at from re_portal_notifications where id=$1`, [portalNotifId]);
  check('a portal notification can be marked read', portalNotifReadAtAfter !== null);

  // ── 052: Archta's own subscription revenue (SECTION 21) ──────────────────
  const subscriptionCols = await colsOf('re_subscriptions');
  check('re_subscriptions has the columns the app selects',
    ['organization_id', 'plan', 'monthly_amount', 'started_at', 'ended_at', 'created_at']
      .every((c) => subscriptionCols.includes(c)), subscriptionCols.join(', '));

  const [{ id: subscriptionId, ended_at: subscriptionEndedAtDefault }] = await q(
    `insert into re_subscriptions (organization_id, plan, monthly_amount) values ($1,'growth',150000) returning id, ended_at`,
    [userId]);
  check('a subscription round-trips and starts active (ended_at null)', subscriptionEndedAtDefault === null);

  let badPlanRefused = false;
  try {
    await q(`insert into re_subscriptions (organization_id, plan, monthly_amount) values ($1,'not_a_real_plan',1000)`, [userId]);
  } catch (err) { badPlanRefused = /check/i.test(err.message); }
  check('re_subscriptions.plan is limited to the five known plans', badPlanRefused);

  let negativeAmountRefused = false;
  try {
    await q(`insert into re_subscriptions (organization_id, plan, monthly_amount) values ($1,'starter',-100)`, [userId]);
  } catch (err) { negativeAmountRefused = /check/i.test(err.message); }
  check('re_subscriptions.monthly_amount cannot be negative', negativeAmountRefused);

  await q(`update re_subscriptions set ended_at = now() where id = $1`, [subscriptionId]);
  const [{ ended_at: subscriptionEndedAfter }] = await q(`select ended_at from re_subscriptions where id=$1`, [subscriptionId]);
  check('a subscription can be ended', subscriptionEndedAfter !== null);

  // ── 053: feature usage tracking (SECTION 22) ──────────────────────────────
  const featureEventCols = await colsOf('re_feature_events');
  check('re_feature_events has the columns adminService.featureUsage selects',
    ['organization_id', 'feature', 'count', 'date', 'created_at'].every((c) => featureEventCols.includes(c)),
    featureEventCols.join(', '));

  await q(`select increment_feature_event($1, 'brief_generated')`, [userId]);
  await q(`select increment_feature_event($1, 'brief_generated')`, [userId]);
  await q(`select increment_feature_event($1, 'brief_generated')`, [userId]);
  const [{ count: featureEventCount }] = await q(
    `select count from re_feature_events where organization_id = $1 and feature = 'brief_generated' and date = current_date`,
    [userId]);
  check('increment_feature_event() accumulates into one row per org/feature/day rather than inserting a new one each time',
    Number(featureEventCount) === 3);

  await q(`select increment_feature_event($1, 'payment_recorded')`, [userId]);
  const [{ 'count': featureRowsForOrg }] = await q(
    `select count(*)::int from re_feature_events where organization_id = $1`, [userId]);
  check('a different feature on the same day gets its own row', Number(featureRowsForOrg) === 2);

  let badFeatureRefused = false;
  try {
    await q(`insert into re_feature_events (organization_id, feature) values ($1, 'not_a_real_feature')`, [userId]);
  } catch (err) { badFeatureRefused = /check/i.test(err.message); }
  check('re_feature_events.feature is limited to the ten known features', badFeatureRefused);

  let duplicateFeatureDayRefused = false;
  try {
    await q(`insert into re_feature_events (organization_id, feature, date) values ($1, 'brief_generated', current_date)`, [userId]);
  } catch (err) { duplicateFeatureDayRefused = /duplicate|unique/i.test(err.message); }
  check('a second direct insert for the same org/feature/day is refused — increment_feature_event is the only safe way to add usage',
    duplicateFeatureDayRefused);

  // ── 054: client-side error reporting ──────────────────────────────────────
  const clientErrorCols = await colsOf('re_client_errors');
  check('re_client_errors has the columns clientErrorService selects/inserts',
    ['organization_id', 'user_id', 'app', 'message', 'stack', 'screen', 'url', 'user_agent', 'created_at', 'resolved_at']
      .every((c) => clientErrorCols.includes(c)), clientErrorCols.join(', '));

  const [{ id: clientErrorId, resolved_at: clientErrorResolvedAtDefault }] = await q(
    `insert into re_client_errors (organization_id, app, message, screen) values ($1,'operator','Cannot read properties of undefined (reading ''current'')','dashboard') returning id, resolved_at`,
    [userId]);
  check('a client error round-trips and starts unresolved', clientErrorResolvedAtDefault === null);

  let badAppRefused = false;
  try {
    await q(`insert into re_client_errors (app, message) values ('not_a_real_app','x')`);
  } catch (err) { badAppRefused = /check/i.test(err.message); }
  check('re_client_errors.app is limited to the three known frontends', badAppRefused);

  let blankMessageInErrorTableRefused = false;
  try {
    await q(`insert into re_client_errors (app) values ('operator')`);
  } catch (err) { blankMessageInErrorTableRefused = /null/i.test(err.message); }
  check('re_client_errors.message is required', blankMessageInErrorTableRefused);

  await q(`update re_client_errors set resolved_at = now() where id = $1`, [clientErrorId]);
  const [{ resolved_at: clientErrorResolvedAfter }] = await q(`select resolved_at from re_client_errors where id=$1`, [clientErrorId]);
  check('a client error can be marked resolved', clientErrorResolvedAfter !== null);

  // admin_wipe_organization — exercised against the SAME fixture org every
  // assertion above this point has been building up (userId), deliberately
  // last: nothing in this file reads that data again after this point, and
  // this is the one function in the whole product whose entire job is
  // deleting rows a normal soft-delete pass would never touch (re_audit_log
  // included) — see migrations/039_admin.sql's own header for why.
  const [{ 'count': projectsBefore }] = await q(
    `select count(*)::int from re_projects where organization_id = $1`, [userId]);
  check('fixture org has projects before the wipe (sanity check)', projectsBefore > 0);

  const [{ admin_wipe_organization: wipeCounts }] = await q(
    `select admin_wipe_organization($1) as admin_wipe_organization`, [userId]);
  check('admin_wipe_organization returns a count per table', wipeCounts && typeof wipeCounts === 'object');

  const [{ 'count': projectsAfter }] = await q(
    `select count(*)::int from re_projects where organization_id = $1`, [userId]);
  check('admin_wipe_organization actually deletes the org\'s projects', projectsAfter === 0);

  const [{ 'count': auditAfter }] = await q(
    `select count(*)::int from re_audit_log where organization_id = $1`, [userId]);
  check('admin_wipe_organization deletes the org\'s audit log too — nothing is left to be evidence for', auditAfter === 0);

  // ── re_admin_actions (migrations/040) — TASK 3 AUDIT FIX ────────────────
  // The platform-level trace admin_wipe_organization cannot reach, since it
  // is not scoped to any single organization_id the way every wiped table
  // above is. Exercised AFTER the wipe above specifically to prove that:
  // even though target_org_id here equals userId (the org just deleted by
  // every table above), this row is untouched by that deletion.
  const adminActionCols = await colsOf('re_admin_actions');
  check('re_admin_actions has the columns adminService selects/inserts',
    ['action', 'target_org_id', 'target_user_email', 'summary', 'metadata', 'created_at']
      .every((c) => adminActionCols.includes(c)), adminActionCols.join(', '));

  const [{ id: adminActionId }] = await q(
    `insert into re_admin_actions (action, target_org_id, target_user_email, summary)
     values ('admin.workspace_hard_deleted', $1, 'buyer@example.com', 'test trace') returning id`,
    [userId]);
  check('an admin action round-trips', !!adminActionId);

  const [{ 'count': adminActionSurvives }] = await q(
    `select count(*)::int from re_admin_actions where target_org_id = $1`, [userId]);
  check('a re_admin_actions row survives admin_wipe_organization for the same org — the whole point of this table',
    adminActionSurvives > 0);

  const [{ ok: adminActionsGrant }] = await q(
    `select has_table_privilege('service_role', 'public.re_admin_actions', 'select')
        and has_table_privilege('service_role', 'public.re_admin_actions', 'insert') as ok`);
  check('service_role can read and write re_admin_actions', adminActionsGrant);

  const [{ noUpdate }] = await q(
    `select not has_table_privilege('service_role', 'public.re_admin_actions', 'update') as "noUpdate"`);
  check('re_admin_actions is append-only — even service_role cannot update a row once written', noUpdate);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err.message);
  process.exit(1);
});
