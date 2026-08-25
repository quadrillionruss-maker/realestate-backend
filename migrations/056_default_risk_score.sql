-- ============================================================
-- Buyer default prediction — SECTION 5 (feature expansion).
--
-- A reservation-level companion to re_customers.credit_score
-- (migrations/023), not a replacement for it: credit_score is "how has this
-- BUYER behaved across everything they've ever bought", scored 0-100 where
-- HIGHER is better. default_risk_score is "how likely is THIS DEAL
-- specifically to default", scored 0-100 where HIGHER is WORSE (the
-- product spec's own "above 70 is high risk"), and lives on the
-- reservation because a buyer with two units can be current on one and
-- sliding on the other — see src/services/defaultRiskService.js for the
-- five weighted signals and why they differ from credit_score's four.
--
-- Nullable, no default: null means "never computed" (a brand new
-- reservation with no payment history yet), distinct from 0 ("computed,
-- and currently no risk signal at all").
--
-- Safe to re-run.
-- ============================================================

alter table re_reservations add column if not exists default_risk_score integer
  check (default_risk_score is null or (default_risk_score >= 0 and default_risk_score <= 100));

create index if not exists idx_re_reservations_default_risk
  on re_reservations(organization_id, default_risk_score desc)
  where default_risk_score is not null and deleted_at is null;
