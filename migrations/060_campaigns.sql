-- ============================================================
-- Campaign tracking — SECTION 11 (feature expansion).
--
-- A campaign is a decision (who, what, when); each re_campaign_deliveries
-- row is one recipient's own outcome for that decision — the same
-- one-decision/many-outcomes split re_notifications already uses for a
-- single send, just one level up (a campaign fans out to many
-- re_notifications rows, in turn). sent_count/delivered_count/failed_count
-- on re_campaigns are a cached summary, recomputed after a send rather than
-- aggregated live on every read of the campaigns list.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  type text not null check (type in ('email', 'sms', 'whatsapp')),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sent')),
  message_body text not null check (length(trim(message_body)) > 0),
  -- {"audience": "all" | "overdue" | "project" | "credit_below",
  --  "project_id": uuid, "credit_score_below": number} — see
  -- campaignService.js's resolveAudience for the exact shape read.
  target_filter jsonb not null default '{}'::jsonb,
  sent_count integer not null default 0,
  delivered_count integer not null default 0,
  failed_count integer not null default 0,
  scheduled_for timestamptz,
  sent_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_re_campaigns_org_created on re_campaigns(organization_id, created_at desc);

create table if not exists re_campaign_deliveries (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references re_campaigns(id) on delete cascade,
  customer_id uuid not null references re_customers(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'failed', 'opened')),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_campaign_deliveries_campaign on re_campaign_deliveries(campaign_id);
create unique index if not exists uniq_re_campaign_deliveries_campaign_customer
  on re_campaign_deliveries(campaign_id, customer_id);

alter table re_campaigns enable row level security;
drop policy if exists "org members access re_campaigns" on re_campaigns;
alter table re_campaign_deliveries enable row level security;
drop policy if exists "org members access re_campaign_deliveries" on re_campaign_deliveries;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_campaigns to service_role;
  grant select, insert, update, delete on public.re_campaign_deliveries to service_role;
  revoke all on public.re_campaigns from anon, authenticated;
  revoke all on public.re_campaign_deliveries from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('060_campaigns.sql')
  on conflict (filename) do nothing;
