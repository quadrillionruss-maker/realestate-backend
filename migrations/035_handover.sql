-- ============================================================
-- Handover checklist and snagging — SECTION 11.
--
-- One checklist per reservation, created deliberately by the owner or sales
-- director once a unit is actually ready (routes/reservations.js prompts
-- this when a reservation is marked 'completed' — it never creates the
-- checklist itself). Snagging items hang off the checklist, not the
-- reservation directly, because "the list of defects reported at handover"
-- is a property of the handover event, not of the sale.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_handover_checklists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reservation_id uuid not null references re_reservations(id) on delete cascade,
  created_by uuid references users(id),
  status text not null default 'pending' check (status in ('pending','inspection_done','issues_raised','resolved','signed_off')),
  handover_date date,
  keys_handed boolean not null default false,
  -- { electricity: '...', water: '...' } — free text, a meter reading is
  -- whatever digits are on the dial at handover, not a typed measurement.
  meter_readings jsonb not null default '{}'::jsonb,
  -- ['Warranty booklet', 'Keys', ...] — a simple checklist, not a table:
  -- the same reasoning re_units.metadata.media already gives for a
  -- developer-chosen, open-ended list browsed on one screen.
  documents_provided jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- One checklist per reservation — a second one would just be a duplicate
-- record of the same handover, not a new event.
create unique index if not exists uniq_re_handover_checklists_reservation
  on re_handover_checklists(reservation_id);

create index if not exists idx_re_handover_checklists_org on re_handover_checklists(organization_id);

create table if not exists re_snagging_items (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references re_handover_checklists(id) on delete cascade,
  organization_id uuid not null,
  description text not null check (length(trim(description)) > 0),
  photo_url text,
  status text not null default 'open' check (status in ('open','acknowledged','fixed','disputed')),
  developer_response text,
  fix_committed_date date,
  fixed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_snagging_items_checklist on re_snagging_items(checklist_id);
create index if not exists idx_re_snagging_items_org on re_snagging_items(organization_id);

alter table re_handover_checklists enable row level security;
drop policy if exists "org members access re_handover_checklists" on re_handover_checklists;
alter table re_snagging_items enable row level security;
drop policy if exists "org members access re_snagging_items" on re_snagging_items;

-- SECTION 11 — the Handover Certificate, generated once every snagging item
-- on a checklist is fixed, is stored the same way the demand letter and the
-- financing letter are: an ordinary re_documents row.
do $$
begin
  alter table re_documents drop constraint if exists re_documents_doc_type_check;
  alter table re_documents
    add constraint re_documents_doc_type_check
    check (doc_type in (
      'allocation_letter', 'deed_of_assignment', 'lease_agreement',
      'subscriber_agreement', 'power_of_attorney', 'receipt',
      'demand_letter', 'financing_letter', 'handover_certificate', 'other'
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

  grant select, insert, update, delete on public.re_handover_checklists to service_role;
  grant select, insert, update, delete on public.re_snagging_items to service_role;
  revoke all on public.re_handover_checklists from anon, authenticated;
  revoke all on public.re_snagging_items from anon, authenticated;
end $$;
