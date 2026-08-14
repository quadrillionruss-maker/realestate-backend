-- ============================================================
-- Direct message thread — SECTION 5.
--
-- One thread per buyer (not per reservation — a buyer holding two units
-- talks to the same developer, not two separate conversations), between the
-- buyer and whichever staff member replies. sender_id is null for a buyer
-- message (a buyer has no users row at all — CLAUDE.md's "somebody holding
-- a link", not an operator) and a staff user id for a staff one.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null references re_customers(id) on delete cascade,
  sender_type text not null check (sender_type in ('buyer','staff')),
  sender_id uuid references users(id),
  message text not null check (length(trim(message)) > 0),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint re_messages_sender_id_matches_type check (
    (sender_type = 'buyer' and sender_id is null) or
    (sender_type = 'staff' and sender_id is not null)
  )
);

create index if not exists idx_re_messages_customer on re_messages(customer_id, created_at);
create index if not exists idx_re_messages_org on re_messages(organization_id);

alter table re_messages enable row level security;
drop policy if exists "org members access re_messages" on re_messages;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_messages to service_role;
  revoke all on public.re_messages from anon, authenticated;
end $$;
