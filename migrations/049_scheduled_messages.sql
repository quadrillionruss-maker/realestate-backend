-- ============================================================
-- Scheduled WhatsApp messages — SECTION 16.
--
-- One row per message a rep asked to go out later rather than now. The
-- hourly sweep (jobs/daily.js's checkScheduledMessages, via
-- scheduledMessageService.js) picks up everything with status='pending'
-- and scheduled_for in the past, attempts notificationService.sendWhatsApp,
-- and marks the row 'sent' or 'failed' — WhatsApp's own 24-hour
-- customer-service-window rule (see notificationService.js's own comment on
-- sendWhatsApp) means even a fully configured workspace can have a send
-- rejected by the API itself, not just an unconfigured one, so 'failed'
-- covers both "not configured" and "configured but WhatsApp refused it" —
-- either way a task is filed so a human sends it by hand instead.
--
-- created_by has no ON DELETE CASCADE — a scheduled message is a fact about
-- what was asked for, and should survive the rep who asked leaving the
-- team, the same reasoning re_audit_log.actor_id is not a hard foreign key
-- at all (this one still is a reference, just non-cascading: unlike the
-- audit log this row is still live application data, not permanent
-- evidence, so ON DELETE SET NULL is enough).
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null references re_customers(id) on delete cascade,
  message text not null check (char_length(message) > 0),
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'sent', 'cancelled', 'failed')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- The hourly sweep's own query: "every pending message whose time has come".
create index if not exists idx_re_scheduled_messages_due
  on re_scheduled_messages(scheduled_for)
  where status = 'pending';

-- The buyer drawer's "Scheduled" tab: every message for one buyer, newest
-- (i.e. soonest-scheduled, but ordered by when it was scheduled FOR) first.
create index if not exists idx_re_scheduled_messages_customer
  on re_scheduled_messages(organization_id, customer_id, scheduled_for desc);

alter table re_scheduled_messages enable row level security;
drop policy if exists "org members access re_scheduled_messages" on re_scheduled_messages;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_scheduled_messages to service_role;
  revoke all on public.re_scheduled_messages from anon, authenticated;
end $$;
