-- ============================================================
-- VAT compliance — SECTION 9 (feature expansion).
--
-- Two layers: a workspace-level CONFIGURATION (re_org_settings — enabled,
-- the rate, inclusive/exclusive) and a per-PAYMENT SNAPSHOT of what was
-- actually applied at the moment that payment was recorded
-- (re_payments.vat_rate/vat_amount/vat_inclusive) — the same "snapshot onto
-- the row, not a live join to workspace settings" pattern
-- re_reservations.commission_rate already uses (migrations/020): a
-- workspace changing its VAT rate next year must not silently rewrite what
-- a receipt from last year is understood to have charged.
--
-- vat_rate defaults to 7.5 — the Nigeria standard rate — matching the
-- product spec's own default; vat_amount is null on a payment recorded
-- before VAT was ever enabled for that workspace, distinct from 0 (VAT
-- enabled, computed, genuinely zero).
--
-- Safe to re-run.
-- ============================================================

alter table re_org_settings add column if not exists vat_enabled boolean not null default false;
alter table re_org_settings add column if not exists vat_rate numeric(5,2) not null default 7.5;
alter table re_org_settings add column if not exists vat_inclusive boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_org_settings_vat_rate_check') then
    alter table re_org_settings
      add constraint re_org_settings_vat_rate_check check (vat_rate >= 0 and vat_rate <= 100);
  end if;
end $$;

alter table re_payments add column if not exists vat_rate numeric(5,2);
alter table re_payments add column if not exists vat_amount numeric;
alter table re_payments add column if not exists vat_inclusive boolean;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('058_vat.sql')
  on conflict (filename) do nothing;
