-- ============================================================
-- ONE PENDING INVITE PER EMAIL, PER TEAM
--
-- team_members' existing unique constraint is (team_id, user_id) —
-- correct once someone has an account, but every not-yet-registered
-- invite carries user_id: null, and Postgres treats every NULL as
-- distinct under a unique constraint. Inviting the same
-- not-yet-registered address twice therefore created two 'invited'
-- rows instead of updating the one already there.
--
-- Scoped to `where user_id is null` so it only ever governs PENDING
-- invites — once someone accepts and gets a real user_id, the
-- existing (team_id, user_id) constraint takes over, exactly as it
-- always has.
-- ============================================================

create unique index if not exists uniq_re_team_members_pending_invite
  on team_members(team_id, invited_email)
  where user_id is null;
