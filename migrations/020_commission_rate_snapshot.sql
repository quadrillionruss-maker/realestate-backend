-- ============================================================
-- COMMISSION RATE, FIXED AT THE RESERVATION
--
-- commissionService.js already copies a rep's rate onto each
-- re_commissions row at ACCRUAL time, so a later rate change never
-- rewrites commission already earned. What was still open: accrual
-- read the rep's CURRENT re_sales_reps.commission_rate live at
-- PAYMENT time — so a rate change made between a reservation's
-- creation and one of its later installments changed what that
-- installment paid out, for a deal that was actually sold at a
-- different rate.
--
-- This column is the fix: the rate is read once, when the
-- reservation is created (routes/reservations.js), and every future
-- accrual on that reservation reads it from here instead of the
-- rep's live rate. Restructuring and rental renewal both keep the
-- same reservation row, so a renegotiated plan still pays out at the
-- rate the deal was originally sold at.
--
-- Backfilled from each reservation's currently-assigned rep's live
-- rate, so an existing reservation accrues at exactly the same rate
-- after this migration as before it — this migration changes what a
-- FUTURE rate edit does, not what any reservation pays today.
-- ============================================================

alter table re_reservations add column if not exists commission_rate numeric;

update re_reservations r
set commission_rate = rs.commission_rate
from re_sales_reps rs
where r.sales_rep_id = rs.id
  and r.commission_rate is null;
