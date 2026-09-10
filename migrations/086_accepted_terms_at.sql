-- ============================================================
-- AUDIT FIX (L1) — signup consent was passive text under the form
-- ("By creating an account, you agree to...") with nothing recording that
-- anyone actually saw or agreed to it — no checkbox to check, no timestamp
-- anywhere. accepted_terms_at is stamped by authService.register the
-- instant an account is created (frontend/index.html's register form now
-- requires the checkbox to be checked before it will even submit), so
-- there is a durable, queryable record of when each account holder agreed,
-- the same way every other consequential fact in this product is recorded
-- rather than merely displayed.
--
-- Nullable, not backfilled: an account created before this shipped genuinely
-- never gave this specific consent through this specific mechanism, and a
-- fabricated timestamp would misrepresent that.
--
-- Safe to re-run.
-- ============================================================

alter table users add column if not exists accepted_terms_at timestamptz;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('086_accepted_terms_at.sql')
  on conflict (filename) do nothing;
