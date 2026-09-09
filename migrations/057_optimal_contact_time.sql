-- ============================================================
-- Dynamic reminder timing — SECTION 6 (feature expansion).
--
-- optimal_contact_day follows the product spec's own convention (0-6,
-- Monday=0) — NOT JavaScript's native Date.getUTCDay() (0=Sunday), which
-- src/services/contactTimingService.js converts between explicitly at its
-- one boundary rather than leaving every caller to remember the offset.
--
-- Both nullable, no default: null means "no pattern yet" (fewer than 3
-- payments — the product spec's own threshold), which
-- collectionsAgent.run() reads as "fall back to the default send time",
-- not as day 0 / hour 0.
--
-- Safe to re-run.
-- ============================================================

alter table re_customers add column if not exists optimal_contact_day smallint
  check (optimal_contact_day is null or (optimal_contact_day >= 0 and optimal_contact_day <= 6));
alter table re_customers add column if not exists optimal_contact_hour smallint
  check (optimal_contact_hour is null or (optimal_contact_hour >= 0 and optimal_contact_hour <= 23));

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('057_optimal_contact_time.sql')
  on conflict (filename) do nothing;
