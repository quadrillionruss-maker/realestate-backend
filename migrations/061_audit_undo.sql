-- ============================================================
-- System log with undo — SECTION 12 (feature expansion).
--
-- reversible defaults false: every one of the ~30 existing audit() call
-- sites in this codebase keeps writing exactly what it always has (the
-- column just defaults in behind them) — only the handful this feature
-- names are updated to also pass reversible:true and a reversal_data
-- snapshot. reversed_at/reversed_by mark an entry once undone; a second
-- undo attempt on the same entry is refused by the route, not by a
-- constraint here, since "already reversed" needs a friendly error, not a
-- 500.
--
-- BUG FIX — reversed_by originally shipped `references users(id)` (no ON
-- DELETE clause, i.e. NO ACTION/RESTRICT). That directly contradicts this
-- table's own established rule (schema.test.js's "re_audit_log has no
-- foreign keys (rows outlive their actor)", and actor_id's own comment a
-- few lines below in the base schema: "must survive the deletion of the
-- user who made it, or the log erases its own evidence"). reversed_by is
-- the same kind of "who did this" pointer as actor_id, just for the undo
-- instead of the original action, and needs the same treatment: whoever
-- undid an action can leave the company (or the platform) too, and
-- adminService.hardDeleteUser's `delete from users` — the one real hard
-- delete this product has — would otherwise fail outright with a foreign
-- key violation the moment it tried to remove a user who had ever undone
-- an audit-logged action in a workspace not being wiped in that same
-- operation. Plain uuid now, matching actor_id; migrations/084 drops the
-- constraint on a database that already has it.
--
-- Safe to re-run.
-- ============================================================

alter table re_audit_log add column if not exists reversible boolean not null default false;
alter table re_audit_log add column if not exists reversed_at timestamptz;
alter table re_audit_log add column if not exists reversed_by uuid;
alter table re_audit_log add column if not exists reversal_data jsonb;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('061_audit_undo.sql')
  on conflict (filename) do nothing;
