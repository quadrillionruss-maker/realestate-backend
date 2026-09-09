-- ============================================================
-- Team attendance and daily log book — SECTION 3 (feature expansion).
--
-- Two independent, unrelated tables sharing one migration file because they
-- shipped in the same request: attendance is who was in today and when,
-- kept by the owner or Head of Sales, one row per person per day. The log
-- book is free-text operational notes (an incident, a visitor, a decision)
-- against the workspace or one of its projects, kept by anyone.
--
-- Neither is in orgContext.js's SOFT_DELETABLE set or softDelete.js's
-- DELETABLE set — deleted_at exists on both for the same reason it exists
-- on re_activities (migrations/029) without being wired into the recycle
-- bin: schema consistency with "every table carries the column" (CLAUDE.md's
-- Org scoping section), not a promise of restore-from-bin UI, which nothing
-- in this feature asked for. A read that needs "live only" filters
-- `.is('deleted_at', null)` explicitly, the same way re_activities reads do.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_attendance (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null references users(id),
  date date not null,
  status text not null check (status in ('present','absent','late','half_day')),
  check_in_time time,
  check_out_time time,
  notes text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One row per person per day — marking the same day again is a correction
-- (upsert), not a second, disagreeing record of whether they showed up.
-- NOT partial (unlike most uniqueness rules in this schema): this table has
-- no restore path, so there is never a soft-deleted row at this key that a
-- live one needs to coexist with — and a partial index cannot be used as an
-- ON CONFLICT target through Supabase's .upsert() (Postgres only infers a
-- partial index for a conflict target when the INSERT itself repeats the
-- same WHERE predicate, which the upsert() API has no way to express).
create unique index if not exists uniq_re_attendance_org_user_date
  on re_attendance(organization_id, user_id, date);

create index if not exists idx_re_attendance_org_date on re_attendance(organization_id, date desc);

create table if not exists re_log_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null references users(id),
  project_id uuid references re_projects(id) on delete set null,
  entry_type text not null check (entry_type in ('incident','update','communication','decision','visitor')),
  content text not null check (length(trim(content)) > 0),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_re_log_entries_org_created on re_log_entries(organization_id, created_at desc);
create index if not exists idx_re_log_entries_project on re_log_entries(project_id, created_at desc) where project_id is not null;

alter table re_attendance enable row level security;
drop policy if exists "org members access re_attendance" on re_attendance;
alter table re_log_entries enable row level security;
drop policy if exists "org members access re_log_entries" on re_log_entries;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_attendance to service_role;
  grant select, insert, update, delete on public.re_log_entries to service_role;
  revoke all on public.re_attendance from anon, authenticated;
  revoke all on public.re_log_entries from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('055_attendance_and_logs.sql')
  on conflict (filename) do nothing;
