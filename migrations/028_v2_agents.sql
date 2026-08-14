-- ============================================================
-- V2 AI workforce — SECTION 11. The five agents named in
-- docs/AI_WORKFORCE.md's v2 status line, plus the Deal Manager that
-- gatekeeps every one of them.
--
-- re_agent_actions is the audit trail Deal Manager writes to for EVERY
-- agent decision, sent or not — a skipped action (buyer opted out, a rep is
-- already handling this, WhatsApp unconfigured) is as much a record worth
-- keeping as a sent one, since "why didn't the agent follow up with this
-- buyer" is exactly the question this table answers.
--
-- whatsapp_opt_out is checked by Deal Manager's own clearance() before any
-- agent sends anything — set the moment a buyer replies "stop" to the
-- WhatsApp number (see whatsappBotService's inbound handler), the same
-- opt-out convention any WhatsApp Business sender is expected to honour.
--
-- last_agent_contact_at is Collections Agent's own record of when it last
-- reached out on a reservation — read by the SAME agent next run to decide
-- whether today's contact would be a repeat, and surfaced on the
-- reservation the way overdue/promise state already is.
--
-- investor_emails is Finance Agent's monthly report's own delivery list —
-- notify_md_email (existing) plus these, comma-separated, since an investor
-- report often goes to more than one person and this product has nowhere
-- else that already models a distribution list.
--
-- Safe to re-run.
-- ============================================================

alter table re_customers add column if not exists whatsapp_opt_out boolean not null default false;
alter table re_reservations add column if not exists last_agent_contact_at timestamptz;
alter table re_org_settings add column if not exists investor_emails text;

create table if not exists re_agent_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  agent_name text not null check (agent_name in (
    'deal_manager', 'collections_agent', 'document_agent', 'sales_agent', 'finance_agent', 'market_intel_agent'
  )),
  customer_id uuid references re_customers(id) on delete set null,
  action_type text not null,
  outcome text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_agent_actions_org_created on re_agent_actions(organization_id, created_at desc);
create index if not exists idx_re_agent_actions_customer on re_agent_actions(customer_id) where customer_id is not null;

alter table re_agent_actions enable row level security;
drop policy if exists "org members access re_agent_actions" on re_agent_actions;

-- Weekly Market Intelligence Agent cache — its own table rather than a
-- column on re_ai_briefs, so a market-intel failure or a slow OpenAI call
-- can never delay or break the daily brief it gets folded into (aiBrief.js
-- reads the latest row here, at most a week old, the same "degrade
-- independently" shape every other AI feature in this product already has).
create table if not exists re_market_intel_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  generated_at timestamptz not null default now(),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_market_intel_org_generated on re_market_intel_reports(organization_id, generated_at desc);

alter table re_market_intel_reports enable row level security;
drop policy if exists "org members access re_market_intel_reports" on re_market_intel_reports;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_agent_actions to service_role;
  revoke all on public.re_agent_actions from anon, authenticated;
  grant select, insert, update, delete on public.re_market_intel_reports to service_role;
  revoke all on public.re_market_intel_reports from anon, authenticated;
end $$;
