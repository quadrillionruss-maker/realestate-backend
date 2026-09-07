-- ============================================================
-- Institutional memory — SECTION 8 of the intelligence/outcome-tracking/AI
-- assistant feature expansion, and the last one. re_project_summaries is
-- the AI-generated plain-English narrative of a project's whole life —
-- generated once, when the project completes (routes/projects.js's own
-- 'project_completed' trigger, migrations/079), never live, never per
-- request. key_metrics is the deterministic half of that same summary —
-- total buyers, default rate, recovery rate, completion time, total
-- collected — computed in code from re_project_events (the SAME source
-- the narrative itself is built from), never asked of the model, per the
-- same rule aiBrief.js and aiAssistantService.js already follow for every
-- other figure in this feature expansion.
--
-- One row per project (unique organization_id+project_id) — a project only
-- completes once, so there is exactly one summary to have. If underlying
-- data changes after the fact (a late-recorded payment, say),
-- projectSummaryService.regenerate() overwrites this row in place rather
-- than the AI assistant reading a stale one with no way to know it drifted.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_project_summaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null references re_projects(id) on delete cascade,
  summary_text text not null,
  key_metrics jsonb not null default '{}'::jsonb,
  generated_by text not null default 'model' check (generated_by in ('model', 'fallback')),
  generated_at timestamptz not null default now(),

  constraint re_project_summaries_org_project_unique unique (organization_id, project_id)
);

alter table re_project_summaries enable row level security;
drop policy if exists "org members access re_project_summaries" on re_project_summaries;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_project_summaries to service_role;
  revoke all on public.re_project_summaries from anon, authenticated;
end $$;
