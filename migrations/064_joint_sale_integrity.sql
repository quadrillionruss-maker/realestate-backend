-- ============================================================
-- Joint sale integrity — AUDIT FIXES (Financial #8, #9).
--
-- Two related gaps in migrations/059's re_joint_sale_parties:
--
-- F8 — "commission splits sum to 100%" was enforced only in application
-- code (jointSaleService.validateParties). Any OTHER write path — a future
-- script, a manual SQL fix, a bug introduced later — could silently produce
-- a split that over- or under-pays commission, with nothing at the
-- database layer to catch it, unlike every other financial invariant this
-- product enforces ("Seven rules the database enforces", CLAUDE.md).
--
-- F9 — jointSaleService.createOrReplace saved a new split as two separate,
-- non-transactional round trips (DELETE the old parties, then INSERT the
-- new ones). Two concurrent saves on the same reservation could interleave
-- those two statements, leaving both the old and new party rows live at
-- once — a split that no longer sums to 100% even though each individual
-- request's own validation passed.
--
-- Fixed together: replace_joint_sale_parties() does the delete+insert in
-- ONE transaction (a PL/pgSQL function body is one transaction as far as
-- its caller is concerned), and the percentage-sum trigger is DEFERRABLE
-- INITIALLY DEFERRED, so it only actually checks the sum once, at that
-- transaction's commit — after both statements have already run, not in
-- the instant between them where the running total is legitimately zero
-- or partial.
--
-- Safe to re-run.
-- ============================================================

-- AUDIT FIX (D4) — a commission split is a historical fact, not just a
-- current setting, the moment a real payment has been attributed against it:
-- re_commissions accrues one row per payment (commissionService.js), and
-- jointSaleService.myJointSaleCommissions/notifyExternalParties both derive
-- a co-seller's earned share from re_joint_sale_parties. replace_joint_sale_
-- parties below used to delete every existing party row outright on every
-- save — editing the split for the NEXT deal silently rewrote what an
-- external agent's already-sent commission statement said they'd earned on
-- every PAST payment too, with nothing left in the database to show what the
-- split actually was when that money was paid. superseded_at marks an old
-- row as no longer live without erasing it — "nothing is ever deleted"
-- (CLAUDE.md) applies to a commission split the same as to a payment once
-- money has moved on the strength of it.
alter table re_joint_sale_parties add column if not exists superseded_at timestamptz;

create or replace function check_joint_sale_percentage_sum() returns trigger as $$
declare
  v_joint_sale_id uuid;
  v_total numeric;
begin
  v_joint_sale_id := coalesce(new.joint_sale_id, old.joint_sale_id);
  -- Only LIVE rows must sum to 100 — a superseded row is deliberately left
  -- in place (see this file's header) and must not be double-counted
  -- alongside the new split that replaced it.
  select coalesce(sum(commission_split_percentage), 0) into v_total
    from re_joint_sale_parties where joint_sale_id = v_joint_sale_id and superseded_at is null;

  -- Zero parties (nothing to validate a sum over — e.g. a joint sale row
  -- that has just been created and not yet given its parties within the
  -- same transaction) is allowed through; anything else must land within
  -- the same 0.05 rounding tolerance jointSaleService.validateParties
  -- already applies for a human-typed split like 33.33/33.33/33.34.
  if v_total != 0 and (v_total < 99.95 or v_total > 100.05) then
    raise exception 'Joint sale % commission splits must sum to 100%% (currently %)', v_joint_sale_id, v_total;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_check_joint_sale_percentage_sum on re_joint_sale_parties;
create constraint trigger trg_check_joint_sale_percentage_sum
  after insert or update or delete on re_joint_sale_parties
  deferrable initially deferred
  for each row execute function check_joint_sale_percentage_sum();

create or replace function replace_joint_sale_parties(
  p_org_id uuid,
  p_reservation_id uuid,
  p_parties jsonb
) returns setof re_joint_sale_parties
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_has_accrued boolean;
begin
  insert into re_joint_sales (organization_id, reservation_id)
  values (p_org_id, p_reservation_id)
  on conflict (reservation_id) do update set reservation_id = excluded.reservation_id
  returning id into v_sale_id;

  -- AUDIT FIX (D4) — a joint sale nobody has been paid against yet has no
  -- history worth preserving: hard-delete stays exactly as it was so a
  -- typo fixed before the first payment doesn't leave a dead row behind
  -- forever. Once a real commission has accrued on this reservation, the
  -- existing LIVE parties are superseded instead — see this file's header.
  select exists(
    select 1 from re_commissions where reservation_id = p_reservation_id and status != 'void'
  ) into v_has_accrued;

  if v_has_accrued then
    update re_joint_sale_parties
      set superseded_at = now()
      where joint_sale_id = v_sale_id and superseded_at is null;
  else
    delete from re_joint_sale_parties where joint_sale_id = v_sale_id;
  end if;

  return query
  insert into re_joint_sale_parties (
    joint_sale_id, party_type, user_id, agent_name, agent_email, agent_phone, commission_split_percentage
  )
  select
    v_sale_id,
    p->>'party_type',
    nullif(p->>'user_id', '')::uuid,
    nullif(p->>'agent_name', ''),
    nullif(p->>'agent_email', ''),
    nullif(p->>'agent_phone', ''),
    (p->>'commission_split_percentage')::numeric
  from jsonb_array_elements(p_parties) as p
  returning *;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant execute on function replace_joint_sale_parties(uuid, uuid, jsonb) to service_role;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('064_joint_sale_integrity.sql')
  on conflict (filename) do nothing;
