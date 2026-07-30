-- ============================================================
-- HARDENING — three things review found that the schema has to
-- carry, because the application cannot enforce them alone.
--
--   A. Session invalidation   a removed employee keeps API access
--   B. One allocation letter  three letters for one unit in circulation
--   C. Overpayment visibility a credit nobody can see
--
-- Safe to re-run. Every CREATE is IF NOT EXISTS, every column add
-- is ADD COLUMN IF NOT EXISTS, every constraint sits in a guard.
-- ============================================================

-- ============================================================
-- SECTION A — SESSION INVALIDATION
--
-- A JWT is valid until it expires, and ours last 30 days. So a
-- sales executive who is fired on Monday still holds a working
-- API token until the end of the month: they can read the buyer
-- list, pull payment histories, and download allocation letters,
-- from any machine, and nothing in the system stops them.
-- Changing their password does not help either — the tokens
-- already issued keep working.
--
-- token_version is the fix, and it is deliberately the cheap one:
-- the claim rides in the token, middleware/auth.js compares it to
-- this column, and bumping the column invalidates every token
-- ever issued to that user at once. A denylist would need a store
-- of live tokens and an eviction policy; a counter needs neither.
--
-- Bumped on: password change, password reset, removal from a team,
-- and any explicit "sign out everywhere".
--
-- Rows that predate this migration get 0, and a token issued
-- before it carries no `tv` claim — auth.js treats a missing claim
-- as 0 so existing sessions keep working rather than logging
-- everybody out on deploy.
-- ============================================================

alter table users add column if not exists token_version integer not null default 0;

-- ============================================================
-- SECTION B — ONE ALLOCATION LETTER PER RESERVATION
--
-- Nothing stopped generating five. Each carries a different
-- reference and generated_at, so a buyer could hold three letters
-- for the same unit at once — and in a dispute, three documents
-- that disagree are worse than none.
--
-- Regenerating is still allowed and still desirable (a corrected
-- letterhead, a re-render after a Chromium failure). It rewrites
-- the SAME row and the same storage path, which is what the
-- document service already does. What this index forbids is a
-- SECOND row, i.e. a second letter with its own reference.
--
-- Guarded: an existing database may already hold duplicates from
-- before the rule existed, and failing the migration would leave
-- the other two sections unapplied. The notice names the problem
-- so it can be cleaned up by hand.
-- ============================================================

do $$
begin
  create unique index if not exists uniq_re_allocation_letter_per_reservation
    on re_documents(reservation_id)
    where doc_type = 'allocation_letter';
exception when unique_violation then
  raise notice
    'Some reservations already have more than one allocation letter; index not created. '
    'Resolve with: select reservation_id, count(*) from re_documents '
    'where doc_type = ''allocation_letter'' group by 1 having count(*) > 1;';
end $$;

-- ============================================================
-- SECTION C — OVERPAYMENT AS A FIRST-CLASS FACT
--
-- A buyer sends ₦5m against a ₦500k installment. The payment is
-- recorded (refusing it would leave money in the bank with nothing
-- in the system to explain it) but the excess used to pass in
-- silence — and an unexplained credit is one of the reliable
-- triggers of a payment dispute here.
--
-- The column is on the PAYMENT, not the schedule: it describes
-- that one transfer, and the same installment can be overpaid
-- more than once. It is a record, not an instruction — nothing
-- moves a credit automatically, because which installment it
-- belongs to is a conversation with the buyer.
-- ============================================================

alter table re_payments add column if not exists overpayment numeric not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_payments_overpayment_check') then
    alter table re_payments
      add constraint re_payments_overpayment_check check (overpayment >= 0);
  end if;
end $$;

-- Finding every unallocated credit has to be one cheap query, or nobody runs it.
create index if not exists idx_re_payments_overpaid
  on re_payments(organization_id, paid_at desc) where overpayment > 0;
