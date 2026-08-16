-- ============================================================
-- Post-handover satisfaction survey — SECTION 18.
--
-- One row per reservation, created the moment its handover checklist is
-- first marked 'signed_off' (handoverService.updateChecklist, via
-- satisfactionSurveyService.js) — never re-created on a later re-save of
-- the same checklist, which is why sent_at is set at creation and the
-- service checks for an existing row before making a new one.
--
-- All three scores are nullable, independently — a buyer may rate overall
-- experience and leave construction quality blank, or answer none of them
-- and only leave a comment. completed_at distinguishes "sent, not yet
-- answered" from "answered" the same way re_hardship_requests distinguishes
-- pending from decided: null is the honest "no answer yet" state, not a
-- sentinel score.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_satisfaction_surveys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reservation_id uuid not null references re_reservations(id) on delete cascade,
  customer_id uuid not null references re_customers(id) on delete cascade,
  sent_at timestamptz not null default now(),
  completed_at timestamptz,
  overall_score integer check (overall_score between 1 and 5),
  construction_quality_score integer check (construction_quality_score between 1 and 5),
  sales_experience_score integer check (sales_experience_score between 1 and 5),
  comments text,
  unique (reservation_id)
);

create index if not exists idx_re_satisfaction_surveys_org
  on re_satisfaction_surveys(organization_id, completed_at);

alter table re_satisfaction_surveys enable row level security;
drop policy if exists "org members access re_satisfaction_surveys" on re_satisfaction_surveys;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_satisfaction_surveys to service_role;
  revoke all on public.re_satisfaction_surveys from anon, authenticated;
end $$;
