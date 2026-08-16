-- ============================================================
-- Buyer portal notification bell — SECTION 20.
--
-- One row per notable event a buyer should hear about: a payment recorded,
-- a document ready to download, a developer posting in their project's
-- community, a hardship request decided, or staff replying to their
-- message. Written by portalNotificationService.js's own notify() — the
-- one entry point every trigger below calls, so a sixth trigger added
-- later gets the bell for free the same way pushService.notify already
-- works for the staff-side bell (SECTION 1).
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_portal_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null references re_customers(id) on delete cascade,
  type text not null check (type in (
    'payment_recorded', 'document_ready', 'developer_update', 'hardship_approved', 'message_received'
  )),
  title varchar(100) not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- The bell's own query: "my unread, newest first".
create index if not exists idx_re_portal_notifications_customer_unread
  on re_portal_notifications(customer_id, created_at desc)
  where read_at is null;
create index if not exists idx_re_portal_notifications_customer_all
  on re_portal_notifications(customer_id, created_at desc);

alter table re_portal_notifications enable row level security;
drop policy if exists "org members access re_portal_notifications" on re_portal_notifications;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_portal_notifications to service_role;
  revoke all on public.re_portal_notifications from anon, authenticated;
end $$;
