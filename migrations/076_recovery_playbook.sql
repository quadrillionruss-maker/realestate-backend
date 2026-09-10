-- ============================================================
-- Recovery playbook — SECTION 4 of the intelligence/outcome-tracking/AI
-- assistant feature expansion. One row per (organization, escalation
-- stage), recomputed weekly (jobs/daily.js, Mondays — the same cadence and
-- isMonday() check aiBrief.js's own Monday project-health summary uses),
-- not on every request the way Section 1/3's own analytics routes are —
-- "for each escalation stage, compute a recommendation" is a materialized
-- fact this table stores, not a live query.
--
-- ── "recovery rate (% who eventually paid)" ──────────────────────────────
-- Same definition Section 1's own avg_days_to_payment_by_escalation_stage
-- already uses (outcomeService.js's PAID_OUTCOME_TYPES: paid_within_24h/7d/
-- 30d) — kept identical on purpose so this table's numbers and Section 1's
-- live analytics never quietly disagree about what "recovered" means for
-- the same underlying rows.
--
-- ── Minimum 10 outcomes per stage ─────────────────────────────────────────
-- The commissioning spec's own safeguard, mandatory before recovery_rate/
-- avg_days_to_recovery/best_channel/best_action_type are populated at all —
-- a stage's row still exists below that bar (sample_size says why), the
-- four derived columns are just left null rather than a rate computed from
-- almost nothing. best_channel/best_action_type apply outcomeService's own
-- MIN_SAMPLE_SIZE (5) to the narrower channel/action_type slice WITHIN an
-- already-10+-sample stage, for the same reason.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_recovery_playbook (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  escalation_stage text not null check (escalation_stage in ('none', 'reminder', 'formal_notice', 'final_notice', 'legal')),
  recovery_rate numeric(5, 4),
  avg_days_to_recovery numeric(6, 2),
  best_channel text check (best_channel is null or best_channel in ('whatsapp', 'email', 'sms', 'call')),
  best_action_type text,
  sample_size integer not null default 0,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint re_recovery_playbook_org_stage_unique unique (organization_id, escalation_stage)
);

-- AUDIT FIX (D7) — recovery_rate is a fraction (numeric(5,4) tops out at
-- 9.9999, so 1.0000 is "100%"), computed by dividing a paid count by a
-- sample_size count elsewhere (recoveryPlaybookService.js). Nothing at the
-- database level stopped a division bug or a bad backfill from writing
-- something outside 0..1 and having every screen that reads this table
-- quietly display a nonsense percentage.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_recovery_playbook_recovery_rate_check') then
    alter table re_recovery_playbook
      add constraint re_recovery_playbook_recovery_rate_check
      check (recovery_rate is null or (recovery_rate >= 0 and recovery_rate <= 1));
  end if;
end $$;

alter table re_recovery_playbook enable row level security;
drop policy if exists "org members access re_recovery_playbook" on re_recovery_playbook;

-- Same reasoning distinct_reservation_org_ids (migrations/010) gives for
-- its own existence: the weekly recompute needs "every org with at least
-- one action outcome" once a week, and PostgREST has no DISTINCT of its
-- own reachable through the query builder.
create or replace function distinct_action_outcome_org_ids()
returns table(organization_id uuid)
language sql
stable
as $$
  select distinct organization_id from re_action_outcomes;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_recovery_playbook to service_role;
  revoke all on public.re_recovery_playbook from anon, authenticated;
  grant execute on function distinct_action_outcome_org_ids() to service_role;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('076_recovery_playbook.sql')
  on conflict (filename) do nothing;
