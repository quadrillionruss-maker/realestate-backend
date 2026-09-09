-- ============================================================
-- Joint sales management — SECTION 10 (feature expansion).
--
-- Deliberately does NOT touch re_commissions or its `unique (payment_id)`
-- lock (migrations/003) — "one commission accrual per payment" is one of
-- CLAUDE.md's seven database-enforced rules, and a joint sale still accrues
-- exactly one commission row per payment, to the reservation's own
-- sales_rep_id, exactly as it always has. What a joint sale adds is a
-- DERIVED split of that same row's amount across co-sellers — computed by
-- src/services/jointSaleService.js, never written as additional
-- re_commissions rows. See that file's own header for the full reasoning.
--
-- One joint sale per reservation (the unique index below) — a reservation
-- either has co-sellers or it doesn't; re-saving replaces the party list
-- rather than creating a second, competing one.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_joint_sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reservation_id uuid not null references re_reservations(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists uniq_re_joint_sales_reservation on re_joint_sales(reservation_id);
create index if not exists idx_re_joint_sales_org on re_joint_sales(organization_id);

create table if not exists re_joint_sale_parties (
  id uuid primary key default gen_random_uuid(),
  joint_sale_id uuid not null references re_joint_sales(id) on delete cascade,
  party_type text not null check (party_type in ('internal_rep', 'external_agent')),
  -- Internal party: a real user. External party: a name/email/phone this
  -- product has no account for — mirrors re_activities' own reasoning for
  -- why "who" sometimes means a users(id) and sometimes means free text.
  user_id uuid references users(id),
  agent_name text,
  agent_email text,
  agent_phone text,
  commission_split_percentage numeric(5,2) not null check (commission_split_percentage > 0 and commission_split_percentage <= 100),
  created_at timestamptz not null default now(),
  check (
    (party_type = 'internal_rep' and user_id is not null)
    or (party_type = 'external_agent' and agent_name is not null)
  )
);

create index if not exists idx_re_joint_sale_parties_sale on re_joint_sale_parties(joint_sale_id);
create index if not exists idx_re_joint_sale_parties_user on re_joint_sale_parties(user_id) where user_id is not null;

alter table re_joint_sales enable row level security;
drop policy if exists "org members access re_joint_sales" on re_joint_sales;
alter table re_joint_sale_parties enable row level security;
drop policy if exists "org members access re_joint_sale_parties" on re_joint_sale_parties;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_joint_sales to service_role;
  grant select, insert, update, delete on public.re_joint_sale_parties to service_role;
  revoke all on public.re_joint_sales from anon, authenticated;
  revoke all on public.re_joint_sale_parties from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('059_joint_sales.sql')
  on conflict (filename) do nothing;
