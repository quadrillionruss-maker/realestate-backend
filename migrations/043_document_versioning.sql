-- ============================================================
-- Document version history — SECTION 10.
--
-- Regenerating a document (documentService.generateDocument) has always
-- rewritten the SAME row in place — deliberately, per this product's own
-- "Seven rules the database enforces": one allocation letter per
-- reservation, one receipt per payment, enforced by the two partial unique
-- indexes below. This section does not remove that guarantee; it changes
-- WHERE it lives. A regeneration now supersedes the old row (status
-- 'superseded', superseded_at/superseded_by set) and inserts a NEW row with
-- version incremented — so the two indexes below are widened to
-- `and superseded_at is null`, meaning "at most one LIVE row", not "at most
-- one row ever". A superseded row is history, exactly like a superseded
-- re_installment_plans row already is (migrations/005's
-- uniq_re_active_plan_per_reservation) — this is the same pattern, applied
-- to documents instead of plans.
--
-- superseded_by has no ON DELETE rule — a document row is never hard
-- deleted (soft delete only), so there is nothing for it to need to survive.
--
-- Existing documents default to version 1, superseded_at null — every
-- document that already exists is, by definition, the only version of
-- itself.
--
-- Safe to re-run.
-- ============================================================

alter table re_documents add column if not exists version integer not null default 1;
alter table re_documents add column if not exists superseded_at timestamptz;
alter table re_documents add column if not exists superseded_by uuid references re_documents(id);

do $$
begin
  alter table re_documents drop constraint if exists re_documents_status_check;
  alter table re_documents
    add constraint re_documents_status_check
    check (status in ('pending', 'generated', 'sent', 'signed', 'superseded'));
exception when check_violation then
  raise exception 're_documents has a row with a status outside the expected set — check before re-running';
end $$;

-- Widened: "one LIVE row", not "one row ever" — see this file's own header.
drop index if exists uniq_re_documents_receipt_per_payment;
create unique index if not exists uniq_re_documents_receipt_per_payment
  on re_documents(payment_id)
  where payment_id is not null and doc_type = 'receipt' and deleted_at is null and superseded_at is null;

do $$
begin
  drop index if exists uniq_re_allocation_letter_per_reservation;
  create unique index if not exists uniq_re_allocation_letter_per_reservation
    on re_documents(reservation_id)
    where doc_type = 'allocation_letter' and deleted_at is null and superseded_at is null;
exception when unique_violation then
  raise notice 'duplicate live allocation letters exist; index not created';
end $$;

-- The Documents screen's own query: "show me the latest version of each
-- (reservation, doc_type)". Partial for the same reason as the two indexes
-- above — most rows are either the only version or long superseded.
create index if not exists idx_re_documents_current_version
  on re_documents(reservation_id, doc_type)
  where superseded_at is null and deleted_at is null;
