-- ============================================================
-- AUDIT FIX (F5) — voiding a payment that resurrected a waived
-- installment used to restore it to 'pending'/'overdue', not 'waived'.
--
-- Nothing at the API is SUPPOSED to let a payment land on a waived
-- installment (routes/payments.js's POST /:scheduleId/record checks for
-- it, and F4's fix to initInstallmentPayment now refuses to even mint a
-- Paystack link for one) — but a buyer can generate a payment link while an
-- installment is still pending/overdue, have someone waive it in the
-- meantime (a hardship arrangement, say), and then complete the
-- already-initiated Paystack checkout: the webhook (handleRealEstateCharge)
-- records the payment with no re-check of current status, and
-- applyPaymentsToSchedule (paystackService.js) flips 'waived' straight to
-- 'paid' with nothing left to say it was ever waived. Voiding that payment
-- afterward then had no way to tell "this was a normal pending/overdue
-- installment that got paid" apart from "this was a waived one that got
-- resurrected" — both looked identical once the status said 'paid' — so
-- every void reverted to pending/overdue, silently un-waiving debt someone
-- had deliberately forgiven.
--
-- waived_before_payment is set the instant a row transitions INTO 'paid'
-- from 'waived', and read (then cleared) on the way back out — see
-- paystackService.applyPaymentsToSchedule.
--
-- Safe to re-run.
-- ============================================================

alter table re_installment_schedule add column if not exists waived_before_payment boolean not null default false;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('085_waived_before_payment.sql')
  on conflict (filename) do nothing;
