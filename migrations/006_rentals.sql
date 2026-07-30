-- ============================================================
-- RENTAL TENANCIES
--
-- Realtika started as an off-plan and outright sales product.
-- Developers running both a sales book and a rental portfolio
-- were keeping the second one in a separate spreadsheet. This
-- migration makes a reservation able to represent a tenancy as
-- well as a sale, additively:
--
--   A. property_type              off_plan | outright | rental
--                                  default 'off_plan' — every
--                                  existing reservation is
--                                  unaffected by this migration
--   B. tenancy_start_date /
--      tenancy_end_date           on the reservation; the end
--                                  date is nullable for an
--                                  open-ended tenancy
--   C. lease_agreement            a third generatable document
--                                  type, alongside the existing
--                                  allocation_letter and
--                                  deed_of_assignment
--   D. an index for the renewal
--      sweep                      "which rentals expire in the
--                                  next 60 days" has to be a fast
--                                  query, not a table scan, once
--                                  a developer has hundreds of
--                                  units under lease
--
-- WHAT THIS DELIBERATELY DOES NOT ADD:
-- A rental's monthly rent schedule is an installment plan in
-- every way the schema already understands one — total_amount =
-- monthly_rent × duration_months, number_of_installments =
-- duration_months, frequency = 'monthly'. re_installment_plans
-- and re_installment_schedule need no rental-specific columns;
-- src/services/installmentService.js already builds this schedule
-- and needs no change either. A renewal reuses the SAME
-- active/superseded lifecycle migrations/005 added for mid-term
-- restructuring — a renewal supersedes the expiring plan and
-- creates a new one for the next period, and
-- uniq_re_active_plan_per_reservation (005) already guarantees
-- exactly one is active at a time, rental or not.
--
-- Safe to re-run.
-- ============================================================

-- ============================================================
-- SECTION A — property_type
-- ============================================================

alter table re_reservations add column if not exists property_type text not null default 'off_plan';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_reservations_property_type_check') then
    alter table re_reservations
      add constraint re_reservations_property_type_check
      check (property_type in ('off_plan','outright','rental'));
  end if;
end $$;

-- ============================================================
-- SECTION B — tenancy dates
--
-- Both nullable at the table level: a sale reservation has neither,
-- and an open-ended tenancy legitimately has a start with no end.
-- Application-level validation (src/routes/reservations.js) requires
-- tenancy_start_date when property_type = 'rental'; the database
-- does not enforce that cross-column rule, matching how the rest of
-- this schema treats "required if" — in the request handler, not a
-- CHECK constraint that would need one more column added later.
-- ============================================================

alter table re_reservations add column if not exists tenancy_start_date date;
alter table re_reservations add column if not exists tenancy_end_date date;

-- ============================================================
-- SECTION C — lease_agreement document type
--
-- Added to the enum only. Whether it RENDERS is a separate question
-- (src/services/documentService.js): deed_of_assignment has sat in
-- this same enum since 001 with no template and returns "unsupported"
-- today, and lease_agreement starts in that same state rather than
-- getting a bespoke template built ahead of the demand for one.
-- ============================================================

do $$
begin
  alter table re_documents drop constraint if exists re_documents_doc_type_check;
  alter table re_documents
    add constraint re_documents_doc_type_check
    check (doc_type in ('allocation_letter','deed_of_assignment','lease_agreement','receipt','other'));
exception when check_violation then
  raise notice 're_documents has a doc_type value outside the known set; constraint not added';
end $$;

-- ============================================================
-- SECTION D — the renewal sweep's index
--
-- jobs/daily.js asks, every morning: which rental reservations have
-- a tenancy_end_date inside the next 60 days? Without this index that
-- is a sequential scan of every reservation in the workspace once a
-- developer has any real number of tenancies under management.
-- ============================================================

create index if not exists idx_re_reservations_tenancy_end
  on re_reservations(organization_id, tenancy_end_date)
  where property_type = 'rental' and tenancy_end_date is not null and deleted_at is null;
