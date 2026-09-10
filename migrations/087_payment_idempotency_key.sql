-- ============================================================
-- AUDIT FIX (FE4) — a client-generated idempotency key identifying ONE
-- submission attempt of a manual payment, distinct from the
-- possibleDuplicate check paystackService.recordManualPayment already has
-- (that one only warns, deliberately — two different staff members
-- recording the SAME real transfer independently is a plausible everyday
-- event, not an error). This is a narrower, harder guarantee: the exact
-- same request — the offline queue (frontend/offline-queue.js) replaying a
-- submission whose first attempt actually succeeded but the client never
-- saw the response, or a double-tap on a slow connection — must not create
-- a second row at all.
--
-- Partial (idempotency_key is not null): a caller that sends no key (an
-- older client, a direct API integration) is completely unaffected —
-- exactly the same shape every other idempotency lock in this schema
-- already uses (uniq_re_payments_paystack_reference, migrations/001/005).
--
-- Safe to re-run.
-- ============================================================

alter table re_payments add column if not exists idempotency_key text;

drop index if exists uniq_re_payments_idempotency_key;
create unique index if not exists uniq_re_payments_idempotency_key
  on re_payments(organization_id, idempotency_key)
  where idempotency_key is not null and deleted_at is null;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('087_payment_idempotency_key.sql')
  on conflict (filename) do nothing;
