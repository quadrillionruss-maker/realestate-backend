-- ============================================================
-- Legal and recovery tracker — SECTION 8.
--
-- A case exists once a buyer's file has actually been handed to a lawyer —
-- opened deliberately (POST /legal-cases, owner only), never automatically,
-- even though a reservation reaching escalation_stage 'legal' is what makes
-- the "Open legal case" button appear in the first place (escalationService's
-- own stage, unchanged by this file). The stage is a trigger for a HUMAN
-- decision, not the decision itself — the same rule every AI/rule-driven
-- surface in this product follows.
--
-- court_dates is jsonb rather than its own table: a handful of entries per
-- case, append-only in practice, browsed on one screen — the same reasoning
-- re_units.metadata already gives for floor plans and photos.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_legal_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null references re_customers(id) on delete cascade,
  reservation_id uuid not null references re_reservations(id) on delete cascade,
  opened_by uuid references users(id),
  status text not null default 'active' check (status in ('active','settled','judgment_obtained','withdrawn','closed')),
  lawyer_name text,
  lawyer_phone text,
  lawyer_email text,
  demand_letter_sent_at timestamptz,
  -- [{ date, outcome }, ...] — a chronological log of court appearances, the
  -- same append-only jsonb-array shape as re_units.metadata.media.
  court_dates jsonb not null default '[]'::jsonb,
  settlement_amount numeric(14,2),
  settlement_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One OPEN case per reservation at a time — a second lawyer engaged on a
-- file that already has one is a coordination failure, not a valid state.
-- A closed/settled/withdrawn/judgment_obtained case does not block a FRESH
-- case being opened later (a buyer who settles and then defaults again).
create unique index if not exists uniq_re_legal_cases_one_active_per_reservation
  on re_legal_cases(reservation_id) where (status = 'active');

create index if not exists idx_re_legal_cases_org_status on re_legal_cases(organization_id, status);
create index if not exists idx_re_legal_cases_customer on re_legal_cases(customer_id);

alter table re_legal_cases enable row level security;
drop policy if exists "org members access re_legal_cases" on re_legal_cases;

-- SECTION 8 — the demand letter this module generates is stored as an
-- ordinary re_documents row (doc_type 'demand_letter'), the same
-- render-then-store-then-signed-URL path every other generated PDF in this
-- product already uses (documentService.js) — reusing that machinery
-- rather than inventing a second storage convention for one more PDF type.
do $$
begin
  alter table re_documents drop constraint if exists re_documents_doc_type_check;
  alter table re_documents
    add constraint re_documents_doc_type_check
    check (doc_type in (
      'allocation_letter', 'deed_of_assignment', 'lease_agreement',
      'subscriber_agreement', 'power_of_attorney', 'receipt', 'demand_letter', 'other'
    ));
exception when check_violation then
  raise exception 're_documents has a row with a doc_type outside the expected set — check before re-running';
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_legal_cases to service_role;
  revoke all on public.re_legal_cases from anon, authenticated;
end $$;
