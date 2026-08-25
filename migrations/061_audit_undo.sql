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
-- Safe to re-run.
-- ============================================================

alter table re_audit_log add column if not exists reversible boolean not null default false;
alter table re_audit_log add column if not exists reversed_at timestamptz;
alter table re_audit_log add column if not exists reversed_by uuid references users(id);
alter table re_audit_log add column if not exists reversal_data jsonb;
