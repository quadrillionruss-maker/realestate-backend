-- ============================================================
-- DAILY JOB: WHICH ORGS TO BRIEF, WITHOUT SCANNING EVERY
-- RESERVATION EVER MADE
--
-- jobs/daily.js needs "every org with at least one live
-- reservation" once a morning. It used to get that by fetching
-- organization_id off every non-cancelled reservation, across
-- every tenant, and de-duplicating in Node — a read that grows
-- forever as the platform's total reservation count grows, to
-- answer a question whose real answer is a short list of ids.
--
-- PostgREST has no DISTINCT of its own reachable through the
-- query builder, so this is the one place in the product that
-- needs a database function rather than a table query.
-- ============================================================

create or replace function distinct_reservation_org_ids()
returns table(organization_id uuid)
language sql
stable
as $$
  select distinct r.organization_id
  from re_reservations r
  where r.status != 'cancelled' and r.deleted_at is null;
$$;

-- Guarded so this file also runs on a plain Postgres (src/test/schema.test.js) —
-- see the Grants section of 001 for why service_role needs this explicitly.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grant';
    return;
  end if;

  grant execute on function distinct_reservation_org_ids() to service_role;
end $$;
