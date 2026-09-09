-- ============================================================
-- A REAL MIGRATIONS LEDGER — replacing MIGRATION_CHECKPOINTS
--
-- The Health tab used to infer "has this migration run?" from a hand-
-- maintained map in adminService.js (MIGRATION_CHECKPOINTS): one entry per
-- migration that creates a new table, checked against the database;
-- everything alter-only in between forward-filled from the next checkpoint.
-- That map has now gone stale twice — once caught and extended in a prior
-- session ("migration checkpoints fix"), and again for 073 through 081,
-- which shipped with no entry and so read as "not applied" regardless of
-- what had actually been run in Supabase. A map someone has to remember to
-- extend by hand, every single time a migration adds a table, will keep
-- going stale — that is a structural problem, not a one-off bug.
--
-- schema_migrations is the fix: every migration file, from this one on,
-- registers itself here as its very last statement —
--   insert into schema_migrations (filename) values ('NNN_name.sql')
--   on conflict (filename) do nothing;
-- — so "applied" becomes a straight lookup with no per-migration code to
-- maintain. The moment a migration is pasted into the Supabase SQL editor
-- and run, its row exists here and the Health tab reflects it on the very
-- next load — no deploy, no map to extend.
--
-- Backfilling every migration through 081 with this same footer line (a
-- follow-up change alongside this file, not part of it) means re-running
-- the full 001-through-082 set — which CLAUDE.md's "Before first use"
-- already documents as the safe, idempotent, always-do-this-after-a-change
-- operation — populates the ledger for every migration ever shipped in one
-- pass, not just future ones.
--
-- The table is ALSO created at the top of 001_phase1_schema.sql (same
-- IF NOT EXISTS), not only here: on a from-scratch database the whole set
-- runs 001 first and 082 last, and 001's own self-registration footer would
-- otherwise fail against a table that doesn't exist yet. Creating it twice,
-- idempotently, is cheaper than getting the chicken-and-egg order wrong.
-- ============================================================

create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
alter table schema_migrations enable row level security;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert on public.schema_migrations to service_role;
  revoke all on public.schema_migrations from anon, authenticated;
end $$;

insert into schema_migrations (filename) values ('082_schema_migrations_ledger.sql')
  on conflict (filename) do nothing;
