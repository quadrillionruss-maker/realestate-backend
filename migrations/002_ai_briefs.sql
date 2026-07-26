-- ============================================================
-- Daily brief history — one row per org per day.
--
-- payload holds the full structured brief (summary, risks,
-- follow_ups, recommendations). It is jsonb rather than columns
-- on purpose: this is the seam the Deal Manager grows into
-- (see docs/AI_WORKFORCE.md), and its shape will change before
-- the table's does.
--
-- organization_id follows the same rule as 001: teams.id for
-- team accounts, users.id for solo accounts, hence no FK.
-- RLS is deny-by-default for the reasons documented in 001.
-- Safe to re-run.
-- ============================================================

create table if not exists re_ai_briefs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brief_date date not null default current_date,
  summary text not null,
  payload jsonb not null,
  generated_by text not null default 'ai' check (generated_by in ('ai','fallback')),
  created_at timestamptz not null default now(),
  unique (organization_id, brief_date)
);

-- Marks whether a brief came from the model or from the rule-based
-- fallback used when OPENAI_API_KEY is absent or the call fails, so a
-- degraded morning is visible rather than silent.
alter table re_ai_briefs add column if not exists generated_by text not null default 'ai';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 're_ai_briefs_generated_by_check'
  ) then
    alter table re_ai_briefs
      add constraint re_ai_briefs_generated_by_check
      check (generated_by in ('ai','fallback'));
  end if;
end $$;

create index if not exists idx_re_ai_briefs_org_date on re_ai_briefs(organization_id, brief_date desc);

alter table re_ai_briefs enable row level security;
drop policy if exists "org members access re_ai_briefs" on re_ai_briefs;
