-- ============================================================
-- Platform-level admin action log — TASK 3 AUDIT FIX (Critical #2).
--
-- migrations/039_admin.sql's admin_wipe_organization deletes a
-- wiped workspace's own re_audit_log as its last step (deliberately
-- — see that migration's header). adminService.hardDeleteUser used
-- to write its "this workspace is about to be permanently deleted"
-- trace INTO that same soon-to-be-deleted re_audit_log, which meant
-- the one durable record of the wipe deleted itself on every
-- successful run — the only thing left afterward was two console.log
-- lines reaching Render's ephemeral retention, not the "auditable,
-- not ad hoc" feature the previous migration's header claims this
-- to be.
--
-- re_admin_actions is a SEPARATE, platform-level table a wipe can
-- never reach, because it is not scoped to any single organization_id
-- the way every wipeable table is — it belongs to the platform, the
-- same reasoning re_cron_runs (migrations/039) is not tenant data
-- either. target_org_id is stored for reference but carries no
-- foreign key and no cascade of any kind, on purpose: the whole
-- point is that this row survives even after the org it describes
-- no longer exists in any other table.
--
-- No deleted_at — permanent, the same reasoning re_audit_log and
-- re_notifications have none (CLAUDE.md's "Nothing is ever deleted").
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_admin_actions (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  -- Reference only — deliberately not a foreign key. A workspace this
  -- describes may be permanently gone from every other table by the
  -- time anyone reads this row; that is exactly the case it exists for.
  target_org_id uuid,
  target_user_email text,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_admin_actions_created on re_admin_actions(created_at desc);
create index if not exists idx_re_admin_actions_org on re_admin_actions(target_org_id, created_at desc);

alter table re_admin_actions enable row level security;
drop policy if exists "org members access re_admin_actions" on re_admin_actions;
-- No policy, same as re_cron_runs — deny-by-default under RLS, and there is
-- no "org members" group to write a policy for: this table is platform-
-- wide, read only through the admin dashboard's own ADMIN_SECRET gate.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert on public.re_admin_actions to service_role;
  revoke all on public.re_admin_actions from anon, authenticated;
end $$;
