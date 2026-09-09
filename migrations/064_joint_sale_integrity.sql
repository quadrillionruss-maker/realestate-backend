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

create or replace function check_joint_sale_percentage_sum() returns trigger as $$
declare
  v_joint_sale_id uuid;
  v_total numeric;
begin
  v_joint_sale_id := coalesce(new.joint_sale_id, old.joint_sale_id);
  select coalesce(sum(commission_split_percentage), 0) into v_total
    from re_joint_sale_parties where joint_sale_id = v_joint_sale_id;

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
begin
  insert into re_joint_sales (organization_id, reservation_id)
  values (p_org_id, p_reservation_id)
  on conflict (reservation_id) do update set reservation_id = excluded.reservation_id
  returning id into v_sale_id;

  delete from re_joint_sale_parties where joint_sale_id = v_sale_id;

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
