-- ============================================================
-- Buyer blacklist — SECTION 7.
--
-- A hard stop, not a warning: a blacklisted buyer cannot be put on a NEW
-- reservation at all (routes/reservations.js's POST / checks this before
-- the unit is even claimed, so a blacklisted buyer never locks a unit out
-- from under someone else while the request 409s). Existing reservations
-- are untouched — blacklisting is forward-looking, and unwinding a live
-- sale is a separate, deliberate action (payments.waive / recycle.delete),
-- not a side effect of this flag.
--
-- Owner only to set or clear (permissions.js's customers.blacklist), same
-- weight as waiving debt or deleting a record: refusing to do business with
-- someone again is a call for the person who answers for the business, not
-- a sales judgment a director makes on their own.
--
-- blacklisted_by has no ON DELETE CASCADE — the fact that a specific person
-- made this call should survive that person leaving the team, the same
-- reasoning re_audit_log.actor_id is not a foreign key at all. A plain
-- reference is enough here since unlike the audit log this is a live,
-- correctable field (unblacklisting clears it), not permanent evidence.
--
-- Safe to re-run.
-- ============================================================

alter table re_customers add column if not exists blacklisted boolean not null default false;
alter table re_customers add column if not exists blacklist_reason text;
alter table re_customers add column if not exists blacklisted_at timestamptz;
alter table re_customers add column if not exists blacklisted_by uuid references users(id);

-- Partial: almost every buyer is never blacklisted, so indexing the whole
-- column would mostly index `false`. This is exactly the "show me the
-- blacklisted ones" scan the Buyers screen's filter runs.
create index if not exists idx_re_customers_blacklisted
  on re_customers(organization_id) where blacklisted = true;
