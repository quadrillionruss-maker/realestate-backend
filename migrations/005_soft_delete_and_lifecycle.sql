-- ============================================================
-- SOFT DELETE, EMAIL VERIFICATION, PLAN RESTRUCTURING
--
--   A. deleted_at everywhere    nothing is ever really gone
--   B. THE LOCKS, REBUILT       every uniqueness rule now ignores
--                               deleted rows — read this section
--   C. Email verification       you cannot claim an address you
--                               do not own
--   D. Plan restructuring       a renegotiated schedule without
--                               losing the payment history
--
-- Safe to re-run.
-- ============================================================

-- ============================================================
-- SECTION A — SOFT DELETE
--
-- This product holds a record of money. A developer who deletes a
-- buyer who has paid ₦15m across eighteen months must not be one
-- click away from losing that; and in a dispute, "we deleted it"
-- is not an answer anyone wants to give a lawyer.
--
-- So nothing is ever removed. deleted_at is stamped, the row
-- disappears from every read the application makes, and it stays
-- in the database and in the audit log permanently.
--
-- TWO TABLES DELIBERATELY DO NOT GET THIS COLUMN:
--   re_audit_log     append-only; deletion is not a concept there,
--                    and a nullable deleted_at would imply it is
--   re_notifications the same — a record of what was sent
-- Giving either one a deleted_at would suggest the evidence can be
-- withdrawn, which is the opposite of why they exist.
--
-- Everything below is a partial index on deleted_at IS NULL,
-- because every application read filters on it and a plain index
-- would be mostly dead weight.
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array[
    're_projects','re_units','re_customers','re_sales_reps','re_reservations',
    're_installment_plans','re_installment_schedule','re_payments','re_documents',
    're_tasks','re_commissions','re_payment_promises','re_ai_briefs'
  ] loop
    execute format('alter table %I add column if not exists deleted_at timestamptz', t);
    execute format('alter table %I add column if not exists deleted_by uuid', t);
    execute format(
      'create index if not exists %I on %I (organization_id) where deleted_at is null',
      'idx_' || t || '_live', t);
  end loop;
end $$;

-- ============================================================
-- SECTION B — THE LOCKS, REBUILT
--
-- READ THIS BEFORE CHANGING ANYTHING ABOVE.
--
-- Every uniqueness rule in 001/003/004 was written before soft
-- delete existed, so each one would now count a DELETED row as
-- live. The consequences, concretely:
--
--   * a soft-deleted reservation would block its unit forever —
--     the unit could never be sold to anyone again
--   * a soft-deleted allocation letter would make it impossible
--     to issue a replacement
--   * a soft-deleted receipt would block re-issuing one
--   * a soft-deleted promise would block logging the next one
--
-- Each index is therefore dropped and recreated with
-- "deleted_at is null" added to its predicate. The rules
-- themselves are unchanged; they now only consider live rows.
-- ============================================================

-- One live reservation per unit. THE double-allocation lock.
drop index if exists uniq_re_active_reservation_per_unit;
create unique index if not exists uniq_re_active_reservation_per_unit
  on re_reservations(unit_id)
  where status in ('reserved','confirmed') and deleted_at is null;

-- Webhook idempotency.
drop index if exists uniq_re_payments_paystack_reference;
create unique index if not exists uniq_re_payments_paystack_reference
  on re_payments(paystack_reference)
  where paystack_reference is not null and method = 'paystack' and deleted_at is null;

-- One receipt per payment.
drop index if exists uniq_re_documents_receipt_per_payment;
create unique index if not exists uniq_re_documents_receipt_per_payment
  on re_documents(payment_id)
  where payment_id is not null and doc_type = 'receipt' and deleted_at is null;

-- One allocation letter per reservation.
do $$
begin
  drop index if exists uniq_re_allocation_letter_per_reservation;
  create unique index if not exists uniq_re_allocation_letter_per_reservation
    on re_documents(reservation_id)
    where doc_type = 'allocation_letter' and deleted_at is null;
exception when unique_violation then
  raise notice 'duplicate live allocation letters exist; index not created';
end $$;

-- One open promise per installment.
drop index if exists uniq_re_open_promise_per_schedule;
create unique index if not exists uniq_re_open_promise_per_schedule
  on re_payment_promises(schedule_id)
  where status = 'open' and deleted_at is null;

-- One commission accrual per payment.
-- This one was a table constraint, not an index, so it has to be
-- converted before it can carry a predicate.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 're_commissions_payment_id_key') then
    alter table re_commissions drop constraint re_commissions_payment_id_key;
  end if;
end $$;

create unique index if not exists uniq_re_commission_per_payment
  on re_commissions(payment_id) where deleted_at is null;

-- Unit numbers are unique per project — among live units, so a
-- deleted unit does not permanently reserve its own number.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 're_units_project_id_unit_number_key') then
    alter table re_units drop constraint re_units_project_id_unit_number_key;
  end if;
exception when others then
  raise notice 'could not drop re_units unique constraint: %', sqlerrm;
end $$;

create unique index if not exists uniq_re_units_number_per_project
  on re_units(project_id, unit_number) where deleted_at is null;

-- ============================================================
-- SECTION C — EMAIL VERIFICATION
--
-- Registration accepted any address, verified or not, which meant
-- anyone could sign up as ceo@somedeveloper.com and be inside the
-- product immediately. In a market where a developer's name is the
-- whole asset, that is an impersonation risk before it is a
-- security one.
--
-- Only the token's SHA-256 is stored, exactly as with password
-- resets, so a leaked row cannot be replayed as a verification
-- link.
--
-- EXISTING ACCOUNTS ARE BACKFILLED AS VERIFIED. They registered
-- before the requirement existed and locking them out on deploy
-- would be a self-inflicted outage. Google accounts are verified
-- by definition — Google already proved the address.
-- ============================================================

alter table users add column if not exists email_verified_at timestamptz;
alter table users add column if not exists verify_token_hash text;
alter table users add column if not exists verify_token_expires_at timestamptz;

-- Backfill: anyone who already exists, plus anyone who arrives via Google.
update users
   set email_verified_at = coalesce(email_verified_at, created_at, now())
 where email_verified_at is null;

create index if not exists idx_users_verify_token on users(verify_token_hash)
  where verify_token_hash is not null;

-- ============================================================
-- SECTION D — PLAN RESTRUCTURING
--
-- A buyer misses three payments and the developer renegotiates
-- rather than cancels — monthly to quarterly, or a three-month
-- moratorium. This happens constantly, and without it in the
-- product the only route was to cancel the reservation and
-- re-enter everything, losing the payment history in the process.
--
-- ── THE MODELLING DECISION, AND WHY ─────────────────────────
-- A restructure creates a NEW plan and supersedes the old one. It
-- does not edit the old plan, because the old schedule is what the
-- buyer's existing receipts refer to.
--
-- The new plan's total_amount is the REMAINING BALANCE, not the
-- original contract value. That is load-bearing: installmentService
-- guarantees the schedule sums to exactly the plan total in kobo,
-- and that invariant is worth more than the convenience of having
-- the contract value in one field.
--
-- The contract value therefore lives in two new columns, so
-- nothing is lost:
--   original_total_amount  what the buyer contracted to pay
--   carried_amount_paid    what they had already paid at restructure
-- and original_total_amount = carried_amount_paid + total_amount.
--
-- Unpaid rows on the OLD schedule are set to 'waived' by the
-- service, so they stop counting as outstanding or overdue while
-- the paid rows and their payments stay exactly as they were.
-- ============================================================

alter table re_installment_plans add column if not exists status text not null default 'active';
alter table re_installment_plans add column if not exists superseded_by uuid;
alter table re_installment_plans add column if not exists restructured_at timestamptz;
alter table re_installment_plans add column if not exists restructure_reason text;
alter table re_installment_plans add column if not exists original_total_amount numeric;
alter table re_installment_plans add column if not exists carried_amount_paid numeric not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_installment_plans_status_check') then
    alter table re_installment_plans
      add constraint re_installment_plans_status_check
      check (status in ('active','superseded'));
  end if;
end $$;

-- A self-reference rather than an FK: a superseded plan may itself
-- be superseded later, and the chain has to survive any single
-- link being soft-deleted.
create index if not exists idx_re_plans_reservation_status
  on re_installment_plans(reservation_id, status) where deleted_at is null;

-- Exactly one ACTIVE plan per reservation. Two active plans means
-- two schedules, two sets of due dates, and a dashboard that
-- double-counts the same debt.
do $$
begin
  create unique index if not exists uniq_re_active_plan_per_reservation
    on re_installment_plans(reservation_id)
    where status = 'active' and deleted_at is null;
exception when unique_violation then
  raise notice
    'some reservations already have more than one active plan; index not created. '
    'Find them with: select reservation_id, count(*) from re_installment_plans '
    'where status = ''active'' and deleted_at is null group by 1 having count(*) > 1;';
end $$;
