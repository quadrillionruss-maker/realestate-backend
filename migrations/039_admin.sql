-- ============================================================
-- Admin dashboard — platform-operator visibility and the one
-- true hard-delete path this product has.
--
-- Two things live here:
--
--   1. re_cron_runs — one row per scheduled job run, so the admin
--      dashboard's Health section can show "last run 14 minutes
--      ago" instead of nothing. jobs/daily.js inserts a row at the
--      start of runDailyJob()/runEveningSweep() and updates it when
--      each finishes (src/routes/admin.js reads the latest row).
--
--   2. admin_wipe_organization(uuid) — the org-wide cascade behind
--      DELETE /api/admin/users/:id. CLAUDE.md's own "Data retention"
--      section names this exact gap: "today, satisfying [an erasure
--      request] means someone with direct database access running a
--      deliberate hard delete... a manual, one-off operation, not a
--      feature." This is that manual operation, made auditable and
--      safe instead of ad hoc — a real function, not a script someone
--      pastes into the SQL editor at 2am. Deliberately a database
--      function rather than a sequence of calls from Node: the ~20
--      tables below have real foreign keys between them (some CASCADE,
--      some RESTRICT — see the ordering notes inline), and a
--      plpgsql function body is one Postgres transaction. Any single
--      DELETE failing rolls back everything else in the function, so
--      a wipe either fully happens or leaves the workspace exactly as
--      it was — never half-erased.
--
--      Deletes re_reservations and re_customers explicitly, in that
--      order; nearly everything else in the schema already cascades
--      or SET NULLs off one of those two per the FK constraints laid
--      down in migrations 001-038, so most of what follows is
--      redundant with that cascade and exists to catch rows that
--      were never attached to a reservation or a customer at all
--      (org settings, agent logs, briefs, the org's own audit trail).
--      re_audit_log is deleted LAST and only here — the one place in
--      this codebase that ever removes a row from it — because a
--      workspace that no longer exists has nothing left for the
--      record to be evidence FOR. See CLAUDE.md's "Nothing is ever
--      deleted" for why every other path leaves it alone.
--
--      Does not touch `users` or `team_members` — src/services/
--      adminService.js deletes those in Node, after this function
--      returns, and only for the user actually being removed.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_cron_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  orgs_processed integer,
  errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_cron_runs_job_started
  on re_cron_runs(job_name, started_at desc);

alter table re_cron_runs enable row level security;
drop policy if exists "org members access re_cron_runs" on re_cron_runs;
-- Deliberately no policy at all, same as every other table in this product
-- (deny-by-default under RLS) — this table has no organization_id because it
-- is platform-wide, not tenant data, so there is no "org members" group to
-- write a policy for in the first place. Only service_role (below) and the
-- admin routes that use it ever touch this table.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_cron_runs to service_role;
  revoke all on public.re_cron_runs from anon, authenticated;
end $$;

-- ── The wipe ────────────────────────────────────────────────────────────
create or replace function admin_wipe_organization(target_org_id uuid)
returns jsonb
language plpgsql
as $$
declare
  counts jsonb := '{}'::jsonb;
  n integer;
begin
  -- Reservations first: re_units.project_id and re_customers themselves are
  -- referenced by re_reservations with ON DELETE RESTRICT (migrations/001),
  -- so a live reservation blocks deleting the unit or buyer under it. Once
  -- reservations are gone, everything hanging off ONE (installment plans →
  -- schedule → payments, commissions, documents, hardship requests, legal
  -- cases, financing requests, handover checklists → snagging items) goes
  -- with them via ON DELETE CASCADE — this single statement is doing most
  -- of the actual work in this function.
  delete from re_reservations where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_reservations', n);

  -- Customers next: messages, community posts → replies, activities,
  -- referrals (both directions) all cascade off customer_id. Now safe —
  -- the reservations that used to RESTRICT this are gone.
  delete from re_customers where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_customers', n);

  -- Units: re_reservations.unit_id no longer blocks this.
  delete from re_units where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_units', n);

  -- Sales reps: re_reservations.sales_rep_id no longer blocks this;
  -- re_commissions cascades off sales_rep_id too (redundant with the
  -- reservation cascade above, harmless).
  delete from re_sales_reps where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_sales_reps', n);

  -- Projects: cascades construction milestones, project health rows,
  -- contractors → contractor payments, and any remaining community posts.
  delete from re_projects where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_projects', n);

  -- Everything below is either not attached to a reservation/customer/
  -- project at all, or a straggler SET NULL left behind rather than
  -- cascaded (re_payment_promises.customer_id, re_plan_recommendations'
  -- customer/unit/reservation columns are all SET NULL, not CASCADE).
  delete from re_payment_promises where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_payment_promises', n);

  delete from re_plan_recommendations where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_plan_recommendations', n);

  delete from re_forecasts where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_forecasts', n);

  delete from re_document_templates where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_document_templates', n);

  delete from re_agent_actions where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_agent_actions', n);

  delete from re_market_intel_reports where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_market_intel_reports', n);

  delete from re_ai_briefs where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_ai_briefs', n);

  delete from re_tasks where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_tasks', n);

  delete from re_notifications where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_notifications', n);

  delete from re_org_settings where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_org_settings', n);

  -- A team workspace's own membership rows and the team itself. Harmless
  -- (0 rows) when target_org_id is actually a solo user's own id, since no
  -- team ever exists at that id.
  delete from team_members where team_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('team_members', n);

  delete from teams where id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('teams', n);

  -- Last, deliberately: the permanent record, for a workspace that no
  -- longer has anything left for it to be a record OF.
  delete from re_audit_log where organization_id = target_org_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('re_audit_log', n);

  return counts;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grant';
    return;
  end if;

  grant execute on function admin_wipe_organization(uuid) to service_role;
end $$;
