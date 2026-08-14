-- ============================================================
-- Contractor and supplier payment tracking — SECTION 12.
--
-- Developer OUTFLOWS, the mirror image of everything else in this schema
-- (which tracks money coming IN from buyers). milestone_id is nullable and
-- deliberately loose — a contractor payment often precedes the milestone it
-- funds, or covers work spanning more than one, so it links to
-- re_construction_milestones (migrations/022) only when a developer chooses
-- to, never required.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_contractors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null references re_projects(id) on delete cascade,
  name text not null,
  type text not null check (type in ('foundation','roofing','finishing','electrical','plumbing','landscaping','other')),
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_contractors_project on re_contractors(project_id);
create index if not exists idx_re_contractors_org on re_contractors(organization_id);

create table if not exists re_contractor_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contractor_id uuid not null references re_contractors(id) on delete cascade,
  project_id uuid not null references re_projects(id) on delete cascade,
  milestone_id uuid references re_construction_milestones(id) on delete set null,
  amount numeric(14,2) not null check (amount > 0),
  due_date date not null,
  paid_date date,
  status text not null default 'pending' check (status in ('pending','paid','overdue')),
  description text,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_contractor_payments_project on re_contractor_payments(project_id, due_date);
create index if not exists idx_re_contractor_payments_org_status on re_contractor_payments(organization_id, status);
create index if not exists idx_re_contractor_payments_contractor on re_contractor_payments(contractor_id);

alter table re_contractors enable row level security;
drop policy if exists "org members access re_contractors" on re_contractors;
alter table re_contractor_payments enable row level security;
drop policy if exists "org members access re_contractor_payments" on re_contractor_payments;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_contractors to service_role;
  grant select, insert, update, delete on public.re_contractor_payments to service_role;
  revoke all on public.re_contractors from anon, authenticated;
  revoke all on public.re_contractor_payments from anon, authenticated;
end $$;
