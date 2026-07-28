-- ============================================================
-- PHASE 1 SCHEMA — Real Estate Sales Ops (Nigeria MVP)
--
-- SELF-CONTAINED. Paste this into the SQL editor of an empty
-- Supabase project and everything the API needs exists. It
-- depends on no pre-existing table — not even auth.users.
--
-- Two sections:
--   A. Identity  — users, teams, team_members
--   B. Domain    — the re_* tables
--
-- Safe to re-run, and safe to run against a database that
-- already has an identity schema: every CREATE is IF NOT EXISTS
-- and every column add is ADD COLUMN IF NOT EXISTS, so existing
-- tables are topped up rather than fought over.
--
-- organization_id — THE SCOPE KEY
--     organization_id = user.team_id ?? user.id
-- It points at teams.id for team accounts and users.id for solo
-- accounts, which is why it carries NO foreign key. It is
-- denormalized onto every table on purpose: one-line org filters
-- and fast dashboard aggregates without 3-level joins. The API
-- sets it explicitly on every insert (src/middleware/orgContext.js)
-- — never inferred by trigger.
-- ============================================================

-- gen_random_uuid() is core Postgres from version 13, and nothing else here
-- needs pgcrypto. The extension is attempted for older servers but its absence
-- is not fatal — some managed platforms disallow CREATE EXTENSION entirely,
-- and failing the whole schema over an unused dependency would be silly.
do $$
begin
  create extension if not exists pgcrypto;
exception when others then
  raise notice 'pgcrypto unavailable; relying on built-in gen_random_uuid()';
end $$;

-- ============================================================
-- SECTION A — IDENTITY
--
-- This service VERIFIES bearer tokens; it does not issue them.
-- These tables therefore hold identity as the API needs to read
-- it, not credentials: there is no password column, because
-- nothing here logs anyone in.
--
-- users.id is a plain UUID with no foreign key. If you sign in
-- with Supabase Auth, insert rows whose id matches the
-- auth.users id so the `sub` in those tokens resolves here. If
-- an external service owns login, use whatever id it puts in the
-- token. Either works; neither is required.
--
-- If you later move identity somewhere else entirely, this whole
-- section can be dropped — Section B references only users(id).
-- ============================================================

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text,
  company_name text,
  -- Letterhead for generated allocation letters (src/services/documentService.js)
  brand_company_name text,
  brand_logo_url text,
  brand_address text,
  brand_phone text,
  brand_website text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Top up an identity table that already existed with the columns the
-- letterhead builder selects. A missing column there is not a blank letter,
-- it is a failed SELECT and a 500.
alter table users add column if not exists full_name text;
alter table users add column if not exists company_name text;
alter table users add column if not exists brand_company_name text;
alter table users add column if not exists brand_logo_url text;
alter table users add column if not exists brand_address text;
alter table users add column if not exists brand_phone text;
alter table users add column if not exists brand_website text;
alter table users add column if not exists updated_at timestamptz not null default now();

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();

-- A workspace shared by several people. Solo accounts never create one —
-- they are scoped by user id instead (see organization_id above).
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Read during authentication (src/middleware/auth.js) to decide whether a
-- caller is scoped by team or as a solo account. `status` matters: only
-- 'active' membership counts, so an invited-but-not-joined row grants nothing.
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  status text not null default 'active' check (status in ('active','invited','removed')),
  invited_email text,
  joined_at timestamptz not null default now(),
  unique (team_id, user_id)
);

create index if not exists idx_team_members_user on team_members(user_id);
create index if not exists idx_team_members_team on team_members(team_id);

-- ============================================================
-- SECTION B — DOMAIN
-- ============================================================

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

-- ---------- Sales reps (platform users tagged for this product) ----------
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

-- ---------- Actual payments ----------
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
-- WHY NO POLICIES: callers authenticate with an HS256 bearer token, not a
-- Supabase Auth session, so auth.uid() is NULL for application traffic. Every
-- query runs server-side through the service-role client, which bypasses RLS
-- by design — that is why each query filters organization_id explicitly. No
-- browser talks to these tables directly.
--
-- Under those conditions "RLS enabled with zero policies" is the strongest
-- correct setting: the anon and authenticated keys can read nothing at all,
-- even if one leaks. A policy written against auth.uid() would be worse than
-- useless — it would silently evaluate to NULL and read as protection that
-- does not exist.
--
-- IF you later expose these tables to a Supabase-Auth browser client, adapt
-- the template at the bottom of this file.
-- ============================================================
alter table users enable row level security;
alter table teams enable row level security;
alter table team_members enable row level security;
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

-- Remove placeholder policies from earlier drafts of this file, which
-- referenced an org_members table that no longer exists.
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

-- ============================================================
-- Grants
--
-- RLS and privileges are two different gates, and BYPASSRLS only opens the
-- first one. service_role still needs ordinary table privileges, and not
-- every Supabase project grants them by default — without this block the API
-- authenticates fine and then fails every query with
-- "42501: permission denied for table re_projects".
--
-- anon and authenticated are revoked explicitly. RLS-with-no-policies already
-- blocks them, but making it true at the privilege layer as well means the
-- deny-by-default promise does not rest on a single mechanism. If you later
-- add the client-side policies templated at the bottom of this file, you must
-- re-grant to those roles — policies alone will not be enough.
--
-- Guarded on the roles existing so the file still runs on a plain Postgres
-- (a local instance, or the in-process one src/test/schema.test.js uses).
-- ============================================================
do $$
declare t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  execute 'grant usage on schema public to service_role';

  foreach t in array array[
    'users','teams','team_members',
    're_projects','re_units','re_customers','re_sales_reps','re_reservations',
    're_installment_plans','re_installment_schedule','re_payments','re_documents','re_tasks'
  ] loop
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ============================================================
-- BOOTSTRAP — a fresh install has no users, and every endpoint
-- requires a token belonging to one. Create yourself:
--
--   insert into users (email, full_name, company_name)
--   values ('you@example.com', 'Your Name', 'Your Company')
--   returning id;
--
-- Then mint a token for that id (see scripts/make-token.js):
--
--   npm run token -- <the returned uuid> you@example.com
--
-- That account is a solo workspace: organization_id = its user id.
-- To make it a team workspace instead:
--
--   insert into teams (name, owner_id) values ('Your Company', '<user-id>')
--   returning id;
--   insert into team_members (team_id, user_id, role)
--   values ('<team-id>', '<user-id>', 'owner');
--
-- Data created before joining a team stays scoped to the user id —
-- see docs/DATABASE.md for the backfill.
-- ============================================================

-- ------------------------------------------------------------
-- FUTURE: client-side access via Supabase Auth. Only meaningful
-- once callers hold Supabase-issued JWTs, and only if users.id
-- mirrors auth.users.id. One policy per table:
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
