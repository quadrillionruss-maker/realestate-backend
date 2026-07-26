-- ============================================================
-- PHASE 1 SCHEMA — Real Estate Sales Ops (Nigeria MVP)
-- Additive to FlowDesk's existing Supabase project. Rebuilds
-- nothing: no auth, no orgs, no billing.
--
-- TARGETED AT FLOWDESK AS IT ACTUALLY IS (verified against
-- database/schema.sql + migrations/009_teams.sql):
--
--  * There is NO `organizations` table. Workspaces are `teams`,
--    membership is `team_members`, and a solo user has
--    `team_id = NULL`.
--  * `public.users` is the profile table (id = auth.users.id).
--  * The API authenticates with FlowDesk's OWN HS256 JWT, not a
--    Supabase Auth session, so `auth.uid()` is NULL for app
--    traffic. RLS below is therefore deny-by-default (see the
--    Row Level Security section for the full reasoning).
--
-- organization_id — THE SCOPE KEY
-- Mirrors FlowDesk's existing src/utils/scopeOwner.js rule:
--     organization_id = user.team_id ?? user.id
-- It therefore points at teams.id for team accounts and users.id
-- for solo accounts, which is why it carries NO foreign key. It
-- is denormalized onto every table on purpose: one-line org
-- filters and fast dashboard aggregates without 3-level joins.
-- The Express layer sets it explicitly on every insert
-- (src/middleware/orgContext.js) — never inferred by trigger.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Projects (a development, e.g. "Lekki Gardens Phase 2") ----------
create table if not exists re_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  location text,
  total_units integer,
  status text not null default 'active' check (status in ('planning','active','sold_out','archived')),
  created_at timestamptz not null default now()
);

-- ---------- Units within a project ----------
create table if not exists re_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null references re_projects(id) on delete cascade,
  unit_number text not null,
  unit_type text,
  size_sqm numeric,
  list_price numeric not null check (list_price >= 0),
  status text not null default 'available' check (status in ('available','reserved','sold')),
  created_at timestamptz not null default now(),
  unique (project_id, unit_number)
);

-- ---------- Buyers / customers ----------
create table if not exists re_customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  full_name text not null,
  email text,
  phone text,
  source text, -- 'referral', 'instagram', 'walk-in', etc.
  created_at timestamptz not null default now()
);

-- ---------- Sales reps (FlowDesk users tagged for this module) ----------
create table if not exists re_sales_reps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

-- ---------- Reservations (unit + customer + rep) ----------
create table if not exists re_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  unit_id uuid not null references re_units(id) on delete restrict,
  customer_id uuid not null references re_customers(id) on delete restrict,
  sales_rep_id uuid references re_sales_reps(id),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'reserved' check (status in ('reserved','confirmed','cancelled','completed')),
  created_at timestamptz not null default now()
);

-- ---------- Installment plan attached to a reservation ----------
create table if not exists re_installment_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reservation_id uuid not null references re_reservations(id) on delete cascade,
  total_amount numeric not null check (total_amount > 0),
  number_of_installments integer not null check (number_of_installments between 1 and 120),
  frequency text not null default 'monthly' check (frequency in ('monthly','quarterly','custom')),
  start_date date not null,
  created_at timestamptz not null default now()
);

-- ---------- Individual scheduled installments ----------
create table if not exists re_installment_schedule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plan_id uuid not null references re_installment_plans(id) on delete cascade,
  installment_number integer not null,
  due_date date not null,
  amount_due numeric not null check (amount_due >= 0),
  status text not null default 'pending' check (status in ('pending','paid','overdue','waived')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (plan_id, installment_number)
);

-- ---------- Actual payments (reuses FlowDesk's Paystack account) ----------
create table if not exists re_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  schedule_id uuid not null references re_installment_schedule(id) on delete cascade,
  amount numeric not null check (amount > 0),
  paystack_reference text,
  method text not null default 'paystack' check (method in ('paystack','bank_transfer','cash','pos')),
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------- Documents (allocation letter, deed of assignment, receipts) ----------
create table if not exists re_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reservation_id uuid not null references re_reservations(id) on delete cascade,
  doc_type text not null check (doc_type in ('allocation_letter','deed_of_assignment','receipt','other')),
  status text not null default 'pending' check (status in ('pending','generated','sent','signed')),
  file_url text,
  storage_path text,
  generated_at timestamptz,
  created_at timestamptz not null default now()
);

-- Buyer documents live in a PRIVATE Storage bucket, so what we persist is the
-- object path; GET /api/re/documents/:id/download mints a short-lived signed
-- URL on demand. (file_url is kept for any future public-bucket use.)
alter table re_documents add column if not exists storage_path text;

-- ---------- Tasks (manual + AI-generated follow-ups) ----------
create table if not exists re_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  assigned_to uuid references public.users(id) on delete set null,
  related_reservation_id uuid references re_reservations(id) on delete set null,
  title text not null,
  notes text,
  due_date date,
  status text not null default 'open' check (status in ('open','done','dismissed')),
  source text not null default 'manual' check (source in ('manual','ai')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- Integrity locks — the rules the product cannot afford to lose
-- ============================================================

-- THE double-allocation lock. The API also claims units with a
-- conditional UPDATE (status='available' in the WHERE clause), but this
-- index is the backstop: Postgres physically cannot hold two live
-- reservations for the same unit, whatever the application does.
create unique index if not exists uniq_re_active_reservation_per_unit
  on re_reservations(unit_id)
  where status in ('reserved','confirmed');

-- Webhook idempotency. Paystack retries deliveries; a replayed
-- charge.success must never insert a second payment row. The service checks
-- for an existing reference first, this makes the check race-proof.
create unique index if not exists uniq_re_payments_paystack_reference
  on re_payments(paystack_reference)
  where paystack_reference is not null and method = 'paystack';

-- ============================================================
-- Indexes — shaped by the queries the dashboard actually runs
-- ============================================================
create index if not exists idx_re_projects_org on re_projects(organization_id);
create index if not exists idx_re_units_project on re_units(project_id);
create index if not exists idx_re_units_org_status on re_units(organization_id, status);
create index if not exists idx_re_customers_org on re_customers(organization_id);
create index if not exists idx_re_reservations_unit on re_reservations(unit_id);
create index if not exists idx_re_reservations_customer on re_reservations(customer_id);
create index if not exists idx_re_reservations_org_status on re_reservations(organization_id, status);
create index if not exists idx_re_schedule_plan on re_installment_schedule(plan_id);
create index if not exists idx_re_schedule_status_due on re_installment_schedule(status, due_date);
create index if not exists idx_re_schedule_org_status_due on re_installment_schedule(organization_id, status, due_date);
create index if not exists idx_re_payments_schedule on re_payments(schedule_id);
create index if not exists idx_re_payments_org_paid_at on re_payments(organization_id, paid_at desc);
create index if not exists idx_re_documents_org_status on re_documents(organization_id, status);
create index if not exists idx_re_tasks_org_status on re_tasks(organization_id, status);

-- ============================================================
-- Row Level Security — deny-by-default
--
-- WHY NO POLICIES: FlowDesk issues its own HS256 JWT and every real
-- estate query runs server-side through the service-role client, which
-- bypasses RLS by design (that is why each query in src/ filters
-- organization_id explicitly). No browser ever talks to these tables
-- directly. Under those conditions "RLS enabled with zero policies" is
-- the strongest correct setting: the anon and authenticated keys can
-- read nothing at all, even if one leaks.
--
-- A policy written against auth.uid() would be worse than useless here —
-- it would silently evaluate to NULL for FlowDesk's tokens and read as
-- protection that does not exist.
--
-- IF you later expose these tables to a Supabase-Auth browser client,
-- uncomment the block at the bottom of this file and adapt it.
-- ============================================================
alter table re_projects enable row level security;
alter table re_units enable row level security;
alter table re_customers enable row level security;
alter table re_sales_reps enable row level security;
alter table re_reservations enable row level security;
alter table re_installment_plans enable row level security;
alter table re_installment_schedule enable row level security;
alter table re_payments enable row level security;
alter table re_documents enable row level security;
alter table re_tasks enable row level security;

-- Drop the placeholder policies from earlier drafts of this file, which
-- referenced an org_members table that FlowDesk does not have.
do $$
declare t text;
begin
  foreach t in array array[
    're_projects','re_units','re_customers','re_sales_reps','re_reservations',
    're_installment_plans','re_installment_schedule','re_payments','re_documents','re_tasks'
  ] loop
    execute format('drop policy if exists %I on %I', 'org members access ' || t, t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- FUTURE: client-side access via Supabase Auth. Only meaningful
-- once users hold Supabase-issued JWTs. One policy per table,
-- following the same team-membership shape as FlowDesk's own
-- teams/team_members policies in migrations/009_teams.sql.
--
-- create policy "re_projects_member_access" on re_projects for all
--   using (
--     organization_id = auth.uid()  -- solo account
--     or organization_id in (
--       select team_id from team_members
--       where user_id = auth.uid() and status = 'active'
--     )
--   );
-- ------------------------------------------------------------
