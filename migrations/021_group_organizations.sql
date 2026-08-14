-- ============================================================
-- Parent organization layer — SECTION 1, multi-branch / multi-company.
--
-- A group account (Mshel Homes Group) can hold several branch
-- workspaces (Mshel Abuja, Mshel Lagos, Mshel Kano), each one an
-- ordinary `teams` row exactly as before. Nothing about a branch's own
-- isolation changes: its organization_id is still its own team id,
-- every existing query still filters on that alone, and a branch MD
-- (team_members.role = 'owner' in their own branch) sees only their
-- own branch, unchanged — that is the existing `owner` role, not a
-- new one ("branch_owner" in the product spec is a label for this,
-- not a new team_members.role value).
--
-- `group_owner` is a different, orthogonal fact: it means
-- parent_organizations.owner_id = you, checked directly by id in
-- src/services/groupService.js, never folded into
-- src/services/permissions.js's per-branch matrix. A person can be the
-- owner of one specific branch AND the group above it at the same
-- time, or neither, or the group without owning any single branch's
-- day-to-day — the two facts are independent on purpose, the same way
-- team ownership and workspace membership already are.
--
-- Safe to re-run.
-- ============================================================

create table if not exists parent_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Nullable: almost every team is standalone and never joins a group.
-- A branch that does keeps `teams.id` as its own organization_id
-- everywhere else in the schema exactly as before — this column is
-- read only by the group dashboard roll-up, never by a per-branch
-- query, so no existing org-scoped read anywhere in the app changes
-- shape or behaviour because of it.
alter table teams add column if not exists parent_organization_id uuid references parent_organizations(id) on delete set null;

create index if not exists idx_teams_parent_org on teams(parent_organization_id) where parent_organization_id is not null;
create index if not exists idx_parent_organizations_owner on parent_organizations(owner_id);

alter table parent_organizations enable row level security;
drop policy if exists "org members access parent_organizations" on parent_organizations;

-- Privileges, for the reasons documented in the Grants section of 001:
-- bypassing RLS does not substitute for holding table privileges.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.parent_organizations to service_role;
  revoke all on public.parent_organizations from anon, authenticated;
end $$;
