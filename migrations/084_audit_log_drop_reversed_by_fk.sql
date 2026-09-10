-- ============================================================
-- BUG FIX — re_audit_log.reversed_by shipped with a foreign key
-- (migrations/061: `reversed_by uuid references users(id)`) that
-- contradicts this table's own rule, tested in src/test/schema.test.js:
-- "re_audit_log has no foreign keys (rows outlive their actor)".
--
-- actor_id has never had one, on purpose — an audit row must survive the
-- deletion of the user who made it, or the log erases its own evidence the
-- first time somebody leaves the company (see the base schema's own
-- comment on that column). reversed_by is the same kind of pointer, just
-- for whoever undid the action instead of whoever did it, and needed the
-- same treatment: adminService.hardDeleteUser's `delete from users` — the
-- one real hard delete this product has — failed outright with a foreign
-- key violation the moment it removed a user who had ever undone an
-- audit-logged action in a workspace not being wiped in that same
-- operation (admin_wipe_organization only clears re_audit_log for orgs it
-- is actually wiping; a workspace the user merely left, where someone else
-- is still active, is never touched).
--
-- 061 itself no longer creates this constraint on a fresh database (see
-- that file's own updated comment); this drops it from one that already
-- has it. The column and its data are untouched — only the constraint
-- goes. re_audit_log_reversed_by_fkey is Postgres's own default name for
-- an unnamed inline `references` on that column.
--
-- Safe to re-run.
-- ============================================================

alter table re_audit_log drop constraint if exists re_audit_log_reversed_by_fkey;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('084_audit_log_drop_reversed_by_fk.sql')
  on conflict (filename) do nothing;
