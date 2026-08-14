-- ============================================================
-- AI sales forecasting — SECTION 6.
--
-- One row per generation, not one row kept fresh in place — a forecast is a
-- snapshot of a moment (this month's pipeline, this month's collection
-- rate), and keeping the history lets "how did last month's projection
-- compare to what actually happened" be answered later without having
-- thrown the old answer away. src/services/forecastService.js reads the
-- latest row by generated_at and only calls OpenAI again if it is more than
-- 24 hours old or the owner clicks Regenerate — see getOrGenerateForecast().
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_forecasts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  generated_at timestamptz not null default now(),
  -- Same vocabulary and the same reasoning as re_ai_briefs.generated_by
  -- (migrations/002): 'fallback' is a deterministic, rule-based projection
  -- (no OPENAI_API_KEY, or the model call failed) — a forecast is still
  -- produced, just without the model's narrative reasoning, and the owner
  -- can see which kind they are looking at.
  generated_by text not null default 'ai' check (generated_by in ('ai', 'fallback')),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_forecasts_org_generated on re_forecasts(organization_id, generated_at desc);

alter table re_forecasts enable row level security;
drop policy if exists "org members access re_forecasts" on re_forecasts;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_forecasts to service_role;
  revoke all on public.re_forecasts from anon, authenticated;
end $$;
