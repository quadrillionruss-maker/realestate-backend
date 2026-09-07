-- ============================================================
-- Developer DNA profile — SECTION 5 of the intelligence/outcome-tracking/
-- AI assistant feature expansion. One row per organization, recomputed
-- weekly (jobs/daily.js, the same Monday sweep Section 4's recovery
-- playbook already runs in) — materialized rather than computed live for
-- the same reason that table is: peer benchmarking needs every eligible
-- org's OWN row already sitting here to average across, and computing
-- eight metrics for every org on the platform inside one request would be
-- exactly the "expensive calculation... synchronously inside a request
-- handler" this feature expansion's own performance rule warns against.
--
-- ── "collections_consistency_score" ──────────────────────────────────────
-- The commissioning spec describes this as "actual vs target". Nothing in
-- this product stores a monthly collection TARGET anywhere — inventing one
-- here would be exactly the fabricated-input this feature expansion was
-- told not to produce. Computed instead as the coefficient of variation
-- (stddev ÷ mean) of the trailing 12 months' own collections against THEIR
-- OWN mean — a real, data-grounded stability measure (lower = more
-- consistent) that needs no external target. Documented as a deviation in
-- this section's own report.
--
-- ── Peer benchmarking ─────────────────────────────────────────────────────
-- Reads straight off this table (every other org's own already-computed
-- row), gated on at least 5 organizations HAVING a row at all — see
-- developerDnaService.getPeerBenchmark's own comment for why 5, and why an
-- individual org's row is never itself exposed to another org, only ever
-- averaged into one anonymous figure.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_developer_dna (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique,

  avg_buyer_default_rate numeric(5, 4),
  avg_days_reservation_to_allocation_letter numeric(6, 2),
  milestone_completion_rate numeric(5, 4),
  restructuring_rate numeric(5, 4),
  avg_restructuring_month numeric(6, 2),
  promise_kept_rate numeric(5, 4),
  avg_credit_score numeric(5, 2),
  collections_consistency_score numeric(6, 4),
  rep_gini_coefficient numeric(5, 4),

  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table re_developer_dna enable row level security;
drop policy if exists "org members access re_developer_dna" on re_developer_dna;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_developer_dna to service_role;
  revoke all on public.re_developer_dna from anon, authenticated;
end $$;
