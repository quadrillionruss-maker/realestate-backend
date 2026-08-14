-- ============================================================
-- Abandoned project early warning system — SECTION 15.
--
-- One row per project per day. Computed by the morning job
-- (jobs/daily.js, via projectHealthService.computeAndStore), never on
-- request — a health score is meant to move slowly and be compared day
-- over day ("below 60 for 3 consecutive days"), which only means something
-- if it is a fixed daily snapshot rather than recomputed fresh on every
-- dashboard load.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_project_health (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null references re_projects(id) on delete cascade,
  health_score integer not null check (health_score between 0 and 100),
  -- { milestone_freshness: {...}, developer_engagement: {...},
  --   collection_trend: {...}, rep_activity: {...}, buyer_complaints: {...} }
  -- — the full breakdown, so a task or a dashboard card can say WHICH
  -- signal(s) actually triggered it rather than just the number.
  signals jsonb not null default '{}'::jsonb,
  -- A plain date, separate from computed_at (below), specifically so the
  -- uniqueness rule can be a real column index rather than an expression
  -- index on computed_at::date — that cast is STABLE, not IMMUTABLE (it
  -- depends on the session's timezone), which Postgres refuses to index.
  computed_date date not null default current_date,
  computed_at timestamptz not null default now()
);

-- One row per project per calendar day — a re-run of the morning job
-- (idempotency, the same reasoning markOverdue's own comment gives) must
-- update today's figure, not append a second one.
create unique index if not exists uniq_re_project_health_project_day
  on re_project_health(project_id, computed_date);

create index if not exists idx_re_project_health_org on re_project_health(organization_id, computed_at desc);

alter table re_project_health enable row level security;
drop policy if exists "org members access re_project_health" on re_project_health;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_project_health to service_role;
  revoke all on public.re_project_health from anon, authenticated;
end $$;
