-- ============================================================
-- Per-user branch access grants — extends SECTION 1's group/branch layer
-- (021_group_organizations.sql) with the piece it deliberately left out:
-- letting a group owner hand a SPECIFIC person read access to a SUBSET of
-- their branches, not just "owns the whole group" or "owns one branch's own
-- workspace". A regional manager over 3 of a group's 10 branches is the
-- motivating case — today the only two positions that exist are "sees
-- exactly one branch" (an ordinary team_members row) and "sees the SUM of
-- every branch under every group you own" (parent_organizations.owner_id,
-- src/services/groupService.js).
--
-- This stays exactly as orthogonal to src/services/permissions.js's five-role
-- matrix as group ownership itself already is (021's own header makes that
-- call explicitly) — a grant here does not create a team_members row, confers
-- no role, and does not let its holder act inside a branch at all. It is
-- read-only visibility into GET /group/dashboard's numbers for the branches
-- named, nothing more. Checked directly by src/services/groupService.js's
-- getBranchesGrantedTo(), never folded into canAccess().
--
-- group_id is carried alongside team_id (not just derived by joining teams)
-- so a branch that is later detached from its group (groupService.detachBranch
-- sets teams.parent_organization_id to null) does not quietly keep handing out
-- access under a group it no longer belongs to — getBranchesGrantedTo() checks
-- the grant's own group_id still matches the branch's CURRENT
-- parent_organization_id before trusting it, same defensive join
-- groupService's dashboard query already relies on elsewhere.
--
-- status flips rather than a row ever being deleted — the same convention
-- team_members already uses for "removed" (migrations/016) rather than a hard
-- delete, since this is a membership-shaped access-control row, not a
-- financial or audit fact; CLAUDE.md's "nothing is ever deleted" is about
-- buyer-facing records, not every ACL edge a product ever draws. Re-granting
-- after a revoke re-activates the same row rather than inserting a second one,
-- which is what the partial unique index below enforces.
--
-- No delete grant to service_role, on purpose — see the Grants block — the
-- same choice 092_approval_requests.sql made for the same reason: nothing in
-- this product's own code should ever need to physically remove this row.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_branch_access_grants (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references parent_organizations(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  granted_by uuid references users(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- One ACTIVE grant per person per branch. A revoke flips status rather than
-- deleting the row (see above), so the index is partial — otherwise a
-- revoked-then-re-granted pair would permanently collide with itself.
create unique index if not exists uniq_re_branch_access_grant_active
  on re_branch_access_grants(team_id, user_id) where status = 'active';

-- getBranchesGrantedTo() filters by user_id and status on every dashboard
-- read; group_id backs listBranchGrants()'s "every grant across groups I own".
create index if not exists idx_re_branch_access_grants_user
  on re_branch_access_grants(user_id) where status = 'active';
create index if not exists idx_re_branch_access_grants_group
  on re_branch_access_grants(group_id) where status = 'active';

alter table re_branch_access_grants enable row level security;
drop policy if exists "org members access re_branch_access_grants" on re_branch_access_grants;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_branch_access_grants to service_role;
  revoke all on public.re_branch_access_grants from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('093_branch_access_grants.sql')
  on conflict (filename) do nothing;
