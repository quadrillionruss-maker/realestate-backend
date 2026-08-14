-- ============================================================
-- Bank financing integration — SECTION 9.
--
-- A buyer applies from the portal using their Archta payment history as
-- proof of creditworthiness; the owner reviews and submits to the named
-- bank by hand — nothing here talks to a bank's API, there isn't one to
-- talk to. status therefore tracks the OWNER's own workflow, set by a
-- human every time (PATCH /financing-requests/:id, owner only), never
-- advanced automatically.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_financing_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null references re_customers(id) on delete cascade,
  reservation_id uuid not null references re_reservations(id) on delete cascade,
  bank_name text not null,
  amount_requested numeric(14,2) not null check (amount_requested > 0),
  status text not null default 'pending' check (status in ('pending','submitted','under_review','approved','rejected','disbursed')),
  submitted_at timestamptz,
  bank_reference text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_financing_org_status on re_financing_requests(organization_id, status);
create index if not exists idx_re_financing_customer on re_financing_requests(customer_id);

alter table re_financing_requests enable row level security;
drop policy if exists "org members access re_financing_requests" on re_financing_requests;

-- SECTION 9 — the Financing Support Letter is stored the same way the
-- demand letter (SECTION 8, migrations/033) is: an ordinary re_documents
-- row, reusing documentService's render → store → signed-URL path rather
-- than a third storage convention for a third kind of generated PDF.
do $$
begin
  alter table re_documents drop constraint if exists re_documents_doc_type_check;
  alter table re_documents
    add constraint re_documents_doc_type_check
    check (doc_type in (
      'allocation_letter', 'deed_of_assignment', 'lease_agreement',
      'subscriber_agreement', 'power_of_attorney', 'receipt', 'demand_letter', 'financing_letter', 'other'
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

  grant select, insert, update, delete on public.re_financing_requests to service_role;
  revoke all on public.re_financing_requests from anon, authenticated;
end $$;
