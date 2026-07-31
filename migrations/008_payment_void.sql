-- ============================================================
-- VOIDING A WRONGLY RECORDED PAYMENT
--
-- Nothing in this API could previously correct a payment entered
-- with the wrong amount — a ₦5,000,000 fat-finger against a
-- ₦500,000 installment instantly marked it paid, emailed a
-- receipt for the wrong figure, and accrued commission on it, with
-- no supported way back short of deleting the whole reservation.
--
-- This does NOT delete or edit the payment row — recycle.js's own
-- rule stands: "a recorded payment is a financial fact... the
-- correction is another entry, not the disappearance of the
-- first one." voided_at/void_reason mark the row as no longer
-- counting, permanently, while the original amount, method and
-- timestamp stay exactly as they were entered — the mistake is
-- still visible, just no longer live.
--
-- A voided payment must stop counting everywhere "how much has
-- been paid" is computed — application code adds
-- `voided_at is null` alongside every such query. Its linked
-- commission (if any) is set to status='void', the schedule row it
-- applied to is recomputed, and the action is audited like any
-- other financial mutation. `POST /payments/:id/void` is
-- owner/admin-gated, the same as waiving debt.
-- ============================================================

alter table re_payments
  add column if not exists voided_at timestamptz;

alter table re_payments
  add column if not exists void_reason text;

-- "Which of this buyer's payments are still live" is a query the schedule
-- recompute, the credit lookup and every report run — it has to be indexed,
-- not a sequential scan of every payment ever voided across the org.
create index if not exists idx_re_payments_voided
  on re_payments(schedule_id) where voided_at is not null;

-- migrations/007's "one reallocation per overpaid payment" index has to
-- become voided_at-aware here, or it stops meaning that: voiding a
-- reallocation is exactly how the credit it moved becomes available to
-- reallocate again, and the old index would still see the row (voided or
-- not) as the one and only reallocation of its source, permanently blocking
-- a second, correct attempt.
drop index if exists uniq_re_payments_reallocation_source;
create unique index if not exists uniq_re_payments_reallocation_source
  on re_payments(reallocated_from_payment_id)
  where reallocated_from_payment_id is not null and voided_at is null;
