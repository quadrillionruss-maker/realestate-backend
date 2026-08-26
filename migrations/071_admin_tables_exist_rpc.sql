-- ============================================================
-- Batched migration-checkpoint existence check — AUDIT FIX (Performance #8).
--
-- adminService.migrationStatus() issued one network round-trip per entry
-- in MIGRATION_CHECKPOINTS (one per table-creating migration — currently
-- in the high 20s) on every single Health-tab load, run in parallel. Each
-- one is individually cheap, but the map grows by roughly one entry per
-- future feature migration that introduces a new table, with no cap and no
-- caching between loads — a linearly-unbounded-over-product-lifetime cost.
-- One call to this function replaces all of them.
--
-- Safe to re-run.
-- ============================================================

create or replace function admin_tables_exist(table_names text[])
returns table (table_name text, table_exists boolean)
language sql
security definer
set search_path = public
as $$
  select t, to_regclass('public.' || t) is not null
  from unnest(table_names) as t;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant execute on function admin_tables_exist(text[]) to service_role;
end $$;
