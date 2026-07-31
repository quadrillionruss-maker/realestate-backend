-- ============================================================
-- WHO ACTUALLY PAID
--
-- A bank transfer in Nigerian property sales often arrives from
-- someone other than the buyer — a spouse's account, a company
-- account, a lawyer's escrow. Nothing previously captured that,
-- so a later dispute over who paid had nothing in the record to
-- settle it. Optional, and nothing in the application branches on
-- it — it is stored for the record and shown on the receipt/audit
-- entry, exactly like every other free-text field on a payment.
-- ============================================================

alter table re_payments add column if not exists payer_name text;
