-- ============================================================
-- Buyer credit scoring — SECTION 3.
--
-- 0-100, computed entirely from data this product already has (payment
-- timeliness, promise-keeping, escalation history) — no new inputs, no
-- external bureau. See src/services/creditScoreService.js for the exact
-- weights and formula.
--
-- Defaults to 100 rather than null: a buyer with no history yet (nothing
-- due, no promises, no reservation) has no evidence against them, and
-- recompute() would score them 100 the moment there IS anything to
-- compute against — the stored default just matches what a fresh buyer's
-- first real computation already produces, so the UI never has to treat
-- "no score yet" as a distinct state from "a good score".
--
-- Safe to re-run.
-- ============================================================

alter table re_customers add column if not exists credit_score integer not null default 100;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 're_customers_credit_score_range'
  ) then
    alter table re_customers
      add constraint re_customers_credit_score_range
      check (credit_score between 0 and 100);
  end if;
end $$;

-- The Buyers screen's credit-score filter buckets by the same four tiers
-- the badge uses (creditScoreService.tier()) — indexed since "show me
-- everyone under 40" is exactly the kind of scan a collections-minded
-- owner runs often.
create index if not exists idx_re_customers_credit_score on re_customers(organization_id, credit_score);
