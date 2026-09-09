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

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('011_payer_name.sql')
  on conflict (filename) do nothing;
