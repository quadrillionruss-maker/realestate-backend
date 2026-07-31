-- ============================================================
-- OVERPAYMENT REALLOCATION
--
-- A buyer who sends more than one installment required leaves a
-- real credit (re_payments.overpayment, migrations/004). Applying
-- that credit to a different installment used to insert a second,
-- independent payment row for the same money — a second
-- commission accrual, a second receipt, and a "total paid" figure
-- that no longer matched what the buyer actually transferred.
--
-- This column marks a payment row as MOVED credit rather than new
-- money: it points at the original overpaid payment the excess
-- came from. Application code reads it to skip commission accrual
-- a second time and to exclude the amount from any "total paid
-- across the plan" sum, since that money was already counted once
-- against the row it points at.
--
-- The unique index is the database-enforced half of the fix: a
-- given overpayment can be moved exactly ONCE. Without it, two
-- concurrent "allocate this credit" clicks could both succeed and
-- spend the same ₦400,000 twice, on two different installments —
-- the same class of race the double-allocation index on
-- reservations already exists to prevent.
-- ============================================================

alter table re_payments
  add column if not exists reallocated_from_payment_id uuid references re_payments(id);

-- Unique rather than a plain index on purpose: it is both the fast lookup
-- ("has this payment's credit already been spent?", checked every time a
-- buyer's record opens) and the constraint that makes double-spending the
-- same credit under concurrency impossible, not just unlikely.
create unique index if not exists uniq_re_payments_reallocation_source
  on re_payments(reallocated_from_payment_id) where reallocated_from_payment_id is not null;
