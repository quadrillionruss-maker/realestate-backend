-- ============================================================
-- PROMPT 7 — Financial Reconciliation. Matches Archta's own payment ledger
-- against what actually settled somewhere else — Paystack's own transaction
-- list (POST /reconciliation/run, by paystack_reference) or a manually
-- uploaded bank statement CSV (POST /reconciliation/bank-transfer, by
-- amount + date within a 2-day window, since a raw bank statement carries no
-- reference Archta ever generated). src/services/reconciliationService.js
-- owns every query against these two tables; routes/reports.js is a thin
-- HTTP layer, owner-only (financial-integrity checks on the business itself,
-- not a director's own book — src/services/permissions.js's own comment on
-- 'reports.reconciliation').
--
-- ── re_reconciliation_runs — one row per "I checked period X" ────────────
-- archta_total/provider_total are each summed independently from their own
-- source (Archta's own re_payments vs. whatever the provider reported for
-- the same period) rather than only over matched rows — the entire point of
-- a reconciliation is to see whether those two independently-computed
-- totals actually agree. status is derived, not chosen by the caller:
-- 'clean' when unmatched_count = 0, 'discrepancies' otherwise.
--
-- ── re_reconciliation_items — one row per line matched, mismatched, or
-- orphaned on either side ─────────────────────────────────────────────────
-- payment_id is nullable: a provider transaction with no corresponding
-- Archta payment (money the provider collected that Archta never recorded —
-- the case most worth flagging) has none to point to. provider_reference is
-- nullable for the mirror image: a bank-transfer CSV row rarely carries any
-- reference Archta would recognise, and an Archta payment with nothing
-- matching it in the statement has no provider reference either.
--
-- organization_id here is a deliberate addition beyond the commissioning
-- spec's own column list for this table (which names only
-- reconciliation_run_id) — every other table in this product carries its
-- own organization_id and is queried by it directly (CLAUDE.md's "Org
-- scoping": "every query filters it explicitly, because the service-role
-- client bypasses RLS by design"); making this table reachable only via a
-- join back through its parent run would be the one query site that
-- forgets that rule, not a simplification of it.
--
-- Neither table has deleted_at — a reconciliation run is a point-in-time
-- record of what was checked and found, same append-only-evidence
-- reasoning re_action_outcomes/re_decision_ledger/re_audit_log already
-- establish elsewhere in this product.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  provider text not null check (provider in ('paystack', 'bank_transfer')),
  period_start date not null,
  period_end date not null,
  archta_total numeric(14,2) not null default 0,
  provider_total numeric(14,2) not null default 0,
  matched_count integer not null default 0,
  unmatched_count integer not null default 0,
  status text not null check (status in ('clean', 'discrepancies')),
  created_at timestamptz not null default now()
);

create index if not exists idx_re_reconciliation_runs_org_created
  on re_reconciliation_runs(organization_id, created_at desc);

create table if not exists re_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reconciliation_run_id uuid not null references re_reconciliation_runs(id) on delete cascade,
  payment_id uuid references re_payments(id) on delete set null,
  provider_reference text,
  archta_amount numeric(14,2),
  provider_amount numeric(14,2),
  status text not null check (status in ('matched', 'mismatched', 'unmatched')),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_reconciliation_items_run
  on re_reconciliation_items(reconciliation_run_id);
create index if not exists idx_re_reconciliation_items_org
  on re_reconciliation_items(organization_id);

alter table re_reconciliation_runs enable row level security;
alter table re_reconciliation_items enable row level security;
drop policy if exists "org members access re_reconciliation_runs" on re_reconciliation_runs;
drop policy if exists "org members access re_reconciliation_items" on re_reconciliation_items;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert on public.re_reconciliation_runs to service_role;
  grant select, insert on public.re_reconciliation_items to service_role;
  revoke all on public.re_reconciliation_runs from anon, authenticated;
  revoke all on public.re_reconciliation_items from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('091_reconciliation.sql')
  on conflict (filename) do nothing;
