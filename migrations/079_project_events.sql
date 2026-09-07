-- ============================================================
-- Longitudinal project timeline — SECTION 7 of the intelligence/outcome-
-- tracking/AI assistant feature expansion. re_project_events is the
-- permanent operational history of one project: one row per meaningful
-- thing that happened, auto-created from the same triggers that already
-- fire for their own primary purpose (see src/services/
-- projectTimelineService.js's own header for the full list and, for the
-- ones NOT wired up, why not).
--
-- event_data is a small jsonb payload specific to event_type — a customer
-- name, an amount, a stage — not a serialized copy of the whole row that
-- triggered it. Kept intentionally light: this table is read back as
-- "what happened, when, in order", not as an audit-grade record of every
-- field on every row (re_audit_log already is that).
--
-- No deleted_at — same reasoning re_audit_log/re_agent_actions/
-- re_action_outcomes already established: institutional memory is
-- exactly the kind of record CLAUDE.md's "Nothing is ever deleted" exists
-- to protect, and SECTION 8's own project summaries (migrations/080) are
-- generated FROM this table — a summary built from a timeline that could
-- later have rows quietly removed would drift from what actually happened.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_project_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null references re_projects(id) on delete cascade,
  event_type text not null check (event_type in (
    'reservation_created', 'payment_received', 'buyer_defaulted', 'buyer_recovered',
    'restructure', 'document_generated', 'milestone_completed', 'construction_delay',
    'buyer_communications', 'legal_action', 'handover', 'project_completed'
  )),
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_project_events_project_created
  on re_project_events(project_id, created_at desc);
create index if not exists idx_re_project_events_org
  on re_project_events(organization_id);

alter table re_project_events enable row level security;
drop policy if exists "org members access re_project_events" on re_project_events;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert on public.re_project_events to service_role;
  revoke all on public.re_project_events from anon, authenticated;
end $$;
