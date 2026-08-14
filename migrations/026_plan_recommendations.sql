-- ============================================================
-- Smart payment plan AI — SECTION 7.
--
-- One row per time a rep clicked "AI Recommendation" while building a
-- reservation, whether or not they went on to use it — see
-- src/services/planRecommendationService.js. `accepted` starts null (not
-- yet decided) and is set true/false by PATCH
-- /reservations/plan-recommendations/:id once the rep actually acts on the
-- suggestion or dismisses it; reservation_id is filled in only on
-- acceptance, so a report can later ask "of the plans this suggested, how
-- many were actually used" without guessing from accepted alone.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_plan_recommendations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid references re_customers(id) on delete set null,
  unit_id uuid references re_units(id) on delete set null,
  requested_by_user_id uuid references public.users(id) on delete set null,
  recommended_installments integer,
  recommended_deposit_percent numeric(5,2),
  recommended_frequency text check (recommended_frequency in ('monthly', 'quarterly')),
  reasoning text,
  -- Same vocabulary as re_ai_briefs.generated_by and re_forecasts.generated_by:
  -- 'fallback' is the deterministic, tier-based heuristic (no
  -- OPENAI_API_KEY, or the model call failed) — a recommendation is still
  -- produced either way.
  generated_by text not null default 'ai' check (generated_by in ('ai', 'fallback')),
  accepted boolean,
  reservation_id uuid references re_reservations(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_plan_recommendations_org on re_plan_recommendations(organization_id, created_at desc);
create index if not exists idx_re_plan_recommendations_customer on re_plan_recommendations(customer_id);

alter table re_plan_recommendations enable row level security;
drop policy if exists "org members access re_plan_recommendations" on re_plan_recommendations;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_plan_recommendations to service_role;
  revoke all on public.re_plan_recommendations from anon, authenticated;
end $$;
