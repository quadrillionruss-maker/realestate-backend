-- ============================================================
-- RBAC — THE FIVE ROLES A NIGERIAN DEVELOPER'S OFFICE
-- ACTUALLY HAS
--
-- owner / admin / member was a generic SaaS hierarchy bolted
-- onto a business that does not work that way. A collections
-- officer is not "an admin who also sells"; a documentation
-- officer must never see what a buyer paid; a sales executive
-- must never see another executive's book. Those are the real
-- separations, and they are what this file installs:
--
--   owner            Chairman / MD — everything
--   sales_director   Head of Sales — all buyers, no money out
--   sales_rep        Sales Executive — their own buyers only
--   collections      Collections / Accounts — money in, no sales
--   documentation    Documentation / Legal — papers, no money
--
-- MIGRATING THE EXISTING TWO:
--   owner  -> owner          (unchanged)
--   admin  -> sales_director
--   member -> sales_rep
--
-- The backfill runs BEFORE the check constraint is tightened,
-- because a CHECK added to a table holding 'admin' rows is
-- rejected outright and the whole migration fails.
--
-- Solo accounts are untouched. They have no team_members row at
-- all, and src/middleware/orgContext.js reads them as 'owner'
-- both before and after this file.
-- ============================================================

-- ── The role vocabulary ───────────────────────────────────────
-- Dropped first, unconditionally, so re-running this file is
-- safe: drop-if-exists → backfill → add. Adding a constraint
-- that already exists is an error, so the drop is not optional.
alter table team_members drop constraint if exists team_members_role_check;

update team_members set role = 'sales_director' where role = 'admin';
update team_members set role = 'sales_rep'      where role = 'member';

alter table team_members
  add constraint team_members_role_check
  check (role in ('owner','sales_director','sales_rep','collections','documentation'));

-- 'member' is no longer a role, so it cannot stay the default.
alter table team_members alter column role set default 'sales_rep';

-- ── Invites ───────────────────────────────────────────────────
-- invited_email already exists (migrations/001) and is used by the
-- current invite flow; `if not exists` makes naming it here a
-- harmless no-op rather than a duplicate-column error.
--
-- invited_role is the role the invitee GETS on acceptance, kept
-- separate from `role` so a pending invite carries its intent
-- even while the row grants nothing (status='invited' is not read
-- by src/middleware/auth.js, which only counts 'active').
alter table team_members add column if not exists invited_email      text;
alter table team_members add column if not exists invited_role       text;
alter table team_members add column if not exists invite_token       text;
alter table team_members add column if not exists invite_expires_at  timestamptz;

alter table team_members drop constraint if exists team_members_invited_role_check;
alter table team_members
  add constraint team_members_invited_role_check
  check (invited_role is null or invited_role in
    ('owner','sales_director','sales_rep','collections','documentation'));

-- The token IS the credential — src/services/inviteService.js looks a row up by
-- it and nothing else — so two rows must never share one. Partial, because
-- every accepted invite clears the token back to null and NULLs are all
-- distinct under a plain unique constraint anyway.
create unique index if not exists uniq_re_team_members_invite_token
  on team_members(invite_token)
  where invite_token is not null;

-- ── Who owns a buyer ──────────────────────────────────────────
-- NOT scope creep: "a sales rep sees only their own buyers" is an
-- explicit requirement of this role model, and re_customers had no
-- column recording who created a buyer — not sales_rep_id, not
-- created_by, nothing. The requirement is unimplementable without
-- one, so it is added here rather than approximated.
--
-- It records the USER (req.userId), not the org and not the
-- re_sales_reps row: a buyer can be added by somebody who is not
-- tagged as a rep at all, and the question this answers is "did
-- this person enter this buyer", which is about the human.
--
-- on delete set null — the buyer outlives the employee who typed
-- them in, exactly like re_audit_log.actor_id outlives its actor.
-- A null reads as "nobody in particular", which is what every row
-- that predates this migration honestly is: the backfill
-- deliberately leaves them null rather than inventing an owner,
-- and src/routes/customers.js treats an unowned buyer as visible
-- only to owner/sales_director/collections.
alter table re_customers
  add column if not exists created_by_user_id uuid references users(id) on delete set null;

create index if not exists idx_re_customers_org_creator
  on re_customers(organization_id, created_by_user_id)
  where deleted_at is null;

-- The reverse of the same question, asked by the reservation and
-- commission filters: "which re_sales_reps rows belong to this
-- user". Matched by user_id, never by email (which the older
-- workload/reassign code did and which breaks the moment somebody
-- changes their address).
create index if not exists idx_re_sales_reps_org_user
  on re_sales_reps(organization_id, user_id);

-- ── Multi-workspace membership ────────────────────────────────
-- A person can now belong to more than one workspace (up to ten,
-- enforced in src/services/inviteService.js — a count, not a
-- constraint, because the limit is a product decision and a
-- database that refuses the eleventh row cannot explain why).
-- src/middleware/auth.js resolves WHICH one per request from the
-- X-Workspace-Id header, so this index backs the lookup that used
-- to be a single-row read.
create index if not exists idx_team_members_user_status
  on team_members(user_id, status);
