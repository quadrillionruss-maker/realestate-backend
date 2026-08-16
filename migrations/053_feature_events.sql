-- ============================================================
-- Feature usage tracking — SECTION 22.
--
-- One row per (organization, feature, calendar day), counting how many
-- times that feature fired that day — not one row per event, which would
-- make "how much does workspace X use imports" a COUNT(*) over a
-- potentially huge table instead of a handful of daily rows to sum.
--
-- increment_feature_event is a tiny SQL function (not a supabase-js
-- .upsert(), which can only ever REPLACE a row's columns, never add to
-- one) for the same reason distinct_reservation_org_ids (migrations/010)
-- exists: some things the PostgREST query builder cannot express at all,
-- and "count = count + 1, atomically, racing every other workspace using
-- the same feature at the same moment" is one of them.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_feature_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  feature text not null check (feature in (
    'brief_generated', 'payment_recorded', 'document_generated', 'agent_action',
    'portal_opened', 'whatsapp_sent', 'import_used', 'hardship_requested',
    'community_posted', 'referral_made'
  )),
  count integer not null default 0 check (count >= 0),
  date date not null default current_date,
  created_at timestamptz not null default now(),
  unique (organization_id, feature, date)
);

-- The admin dashboard's own two queries: "every feature, last 30 days" and
-- "every feature this ONE org has ever used".
create index if not exists idx_re_feature_events_date on re_feature_events(date);
create index if not exists idx_re_feature_events_org on re_feature_events(organization_id, feature);

alter table re_feature_events enable row level security;
drop policy if exists "org members access re_feature_events" on re_feature_events;

create or replace function increment_feature_event(p_organization_id uuid, p_feature text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into re_feature_events (organization_id, feature, date, count)
  values (p_organization_id, p_feature, current_date, 1)
  on conflict (organization_id, feature, date)
  do update set count = re_feature_events.count + 1;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_feature_events to service_role;
  revoke all on public.re_feature_events from anon, authenticated;
  grant execute on function increment_feature_event(uuid, text) to service_role;
end $$;
