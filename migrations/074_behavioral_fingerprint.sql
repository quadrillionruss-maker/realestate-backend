-- ============================================================
-- Buyer behavioral fingerprint — SECTION 2 of the intelligence/outcome-
-- tracking/AI assistant feature expansion.
--
-- ── WHAT IS NOT HERE, AND WHY ────────────────────────────────────────────
-- "preferred_contact_day_of_week" and its hour are NOT new columns.
-- re_customers.optimal_contact_day / optimal_contact_hour (migrations/057)
-- already ARE that exact concept — contactTimingService.js's own header:
-- "the day of the week... this buyer's payments most often land on", with
-- the identical Monday=0 convention and the identical <3-observations-is-
-- null rule this section's commissioning spec asks for. A second column
-- computing the same thing from the same data would just be two answers to
-- one question, with no way to know which one a reader should trust —
-- exactly what this feature expansion's own closing rule ("prefer
-- extending the existing implementation... report the conflict before
-- making architectural changes") exists to prevent. src/services/
-- behavioralFingerprintService.js reads those two existing columns
-- straight through into its own API response instead.
--
-- ── The five genuinely new columns ───────────────────────────────────────
--   preferred_payment_day_of_month   1-31, computed from re_payments.paid_at
--   preferred_contact_channel        whatsapp/email/call — which channel's
--                                    re_action_outcomes (migrations/073)
--                                    close fastest for THIS buyer. sms is
--                                    deliberately not a choice here — the
--                                    commissioning spec's own field
--                                    definition names only these three.
--   avg_days_to_pay_after_reminder   from re_action_outcomes.days_to_outcome
--   promise_reliability_score        0-100 — the same kept/resolved ratio
--                                    creditScoreService's promise_reliability
--                                    dimension already computes (that
--                                    service's own 20-point WEIGHT on it is
--                                    a component of a different, blended
--                                    score; this is that same ratio read on
--                                    its own 0-100 scale), reused rather
--                                    than a second promise-counting query.
--   typical_payment_amount_pattern   full/partial/variable
--
-- behavioral_sample_sizes (jsonb) is the "store observation counts" and
-- "minimum sample size" safeguards made concrete: one small object rather
-- than five more integer columns, keyed by the same names above minus the
-- day-of-week/hour pair (which already carries its own 3-payment minimum
-- inside contactTimingService and needs no second count stored here).
--
-- Safe to re-run.
-- ============================================================

alter table re_customers add column if not exists preferred_payment_day_of_month integer;
alter table re_customers add column if not exists preferred_contact_channel text;
alter table re_customers add column if not exists avg_days_to_pay_after_reminder numeric(6, 2);
alter table re_customers add column if not exists promise_reliability_score integer;
alter table re_customers add column if not exists typical_payment_amount_pattern text;
alter table re_customers add column if not exists behavioral_sample_sizes jsonb not null default '{}'::jsonb;
alter table re_customers add column if not exists behavioral_fingerprint_computed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_customers_pref_payment_day_range') then
    alter table re_customers
      add constraint re_customers_pref_payment_day_range
      check (preferred_payment_day_of_month is null or preferred_payment_day_of_month between 1 and 31);
  end if;

  if not exists (select 1 from pg_constraint where conname = 're_customers_pref_contact_channel_check') then
    alter table re_customers
      add constraint re_customers_pref_contact_channel_check
      check (preferred_contact_channel is null or preferred_contact_channel in ('whatsapp', 'email', 'call'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 're_customers_promise_reliability_range') then
    alter table re_customers
      add constraint re_customers_promise_reliability_range
      check (promise_reliability_score is null or promise_reliability_score between 0 and 100);
  end if;

  if not exists (select 1 from pg_constraint where conname = 're_customers_payment_pattern_check') then
    alter table re_customers
      add constraint re_customers_payment_pattern_check
      check (typical_payment_amount_pattern is null or typical_payment_amount_pattern in ('full', 'partial', 'variable'));
  end if;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('074_behavioral_fingerprint.sql')
  on conflict (filename) do nothing;
