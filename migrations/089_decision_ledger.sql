-- ============================================================
-- Decision Ledger — records when a human's actual action differs from what
-- Archta recommended, and closes out later with whatever actually happened.
-- Same shape as re_action_outcomes (migrations/073): a row is created the
-- moment a recommendation is compared against a decision (outcome_type null
-- — "open") and closed later in place (outcome_type/outcome_recorded_at/
-- days_to_outcome/amount_recovered set), rather than a second row.
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────────
-- The daily brief, the Collections Agent, and the two rule-based
-- recommendation functions this feature adds to hardship review and
-- restructuring all produce a recommendation today with nothing recording
-- what a human actually did about it, or whether that worked out. This is
-- the learning loop: was_override + a later outcome is what lets an owner
-- (or, eventually, Archta itself) see whether ignoring its own advice
-- performed better or worse.
--
-- ── recommendation_type: two reserved values ──────────────────────────────
-- 'escalation' and 'document_action' have no trigger wired to them in this
-- pass — reserved for a future population source, same as this codebase
-- names an enum value ahead of the feature that will use it elsewhere
-- (re_client_errors.app already lists 'portal' before anything wrote to it).
--
-- ── customer_id is nullable — a deviation from re_action_outcomes ────────
-- That table's customer_id is not null; every trigger wired here always has
-- a real customer, but the two reserved recommendation_types above may end
-- up project-scoped only, so the column is not forced not-null ahead of
-- that being decided.
--
-- ── outcome_type: paid/ignored/promised/escalated ─────────────────────────
-- A narrower vocabulary than re_action_outcomes' own paid_within_24h/7d/30d
-- split — this table is about which of four THINGS happened next, not how
-- fast; 'days_to_outcome' already carries the timing.
--
-- ── Not soft-deletable ─────────────────────────────────────────────────────
-- Same reasoning re_action_outcomes/re_audit_log/re_notifications already
-- establish: an evidence trail an owner reads analytics off of, not a live
-- record a soft-delete cascade should ever need to hide.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_decision_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid references re_customers(id) on delete cascade,
  reservation_id uuid references re_reservations(id) on delete set null,
  project_id uuid references re_projects(id) on delete set null,

  recommendation_type text not null check (recommendation_type in (
    'collections_timing', 'channel_choice', 'escalation',
    'restructure', 'hardship', 'document_action'
  )),

  -- What Archta suggested: {action, channel, timing, reason, ...}. What the
  -- human actually did: {action, channel, timing, user_id, ...}. Both jsonb
  -- rather than a fixed column per shape — the "recommendation" and
  -- "decision" look structurally different per recommendation_type (a
  -- channel choice vs. an approve/deny decision vs. a restructure), and
  -- forcing one fixed set of columns across all six would leave most of
  -- them null for any given row.
  archta_recommendation jsonb,
  human_decision jsonb,
  was_override boolean not null default false,

  outcome_type text check (outcome_type in ('paid', 'ignored', 'promised', 'escalated')),
  outcome_recorded_at timestamptz,
  days_to_outcome integer,
  amount_recovered numeric(14, 2),

  created_at timestamptz not null default now(),

  constraint re_decision_ledger_outcome_needs_recorded_at
    check ((outcome_type is null) = (outcome_recorded_at is null)),
  constraint re_decision_ledger_days_to_outcome_non_negative
    check (days_to_outcome is null or days_to_outcome >= 0)
);

-- Every org-wide analytics read, newest first.
create index if not exists idx_re_decision_ledger_org_created
  on re_decision_ledger(organization_id, created_at desc);
-- The buyer-drawer read: every ledger row for one customer, newest first.
create index if not exists idx_re_decision_ledger_customer
  on re_decision_ledger(customer_id, created_at desc) where customer_id is not null;
-- The two queries every closer actually makes: "this customer's most recent
-- OPEN row" (closeOutcome) and "every still-open row past a cutoff, across
-- every org in one pass" (the nightly stale-entry sweep).
create index if not exists idx_re_decision_ledger_open
  on re_decision_ledger(organization_id, customer_id, created_at desc) where outcome_type is null;

alter table re_decision_ledger enable row level security;
drop policy if exists "org members access re_decision_ledger" on re_decision_ledger;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_decision_ledger to service_role;
  revoke all on public.re_decision_ledger from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('089_decision_ledger.sql')
  on conflict (filename) do nothing;
