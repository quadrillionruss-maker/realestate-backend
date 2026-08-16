-- ============================================================
-- Archta's OWN subscription revenue — SECTION 21.
--
-- This is NOT developer customer revenue (a workspace's collected
-- installments, tracked throughout the rest of this product) — it is what
-- a WORKSPACE pays ARCHTA to use the platform. One row per active or past
-- subscription period; ended_at null means still active, the same
-- "null is the live/current state" convention re_installment_plans'
-- superseded_at and re_documents' superseded_at already use.
--
-- Platform-wide, not tenant data: no organization_id-scoped RLS policy,
-- same reasoning re_admin_actions/re_cron_runs give for having none — deny
-- by default, read only through the admin dashboard's own ADMIN_SECRET
-- gate. organization_id still references a workspace (which one is
-- paying), it just carries no foreign key, the same "must survive the
-- workspace itself being gone" reasoning re_admin_actions.target_org_id
-- already documents.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plan text not null check (plan in ('founder', 'starter', 'growth', 'scale', 'enterprise')),
  monthly_amount numeric not null check (monthly_amount >= 0),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

-- The revenue report's own query: "every currently-active subscription".
create index if not exists idx_re_subscriptions_active
  on re_subscriptions(organization_id) where ended_at is null;
create index if not exists idx_re_subscriptions_ended
  on re_subscriptions(ended_at) where ended_at is not null;

alter table re_subscriptions enable row level security;
drop policy if exists "org members access re_subscriptions" on re_subscriptions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_subscriptions to service_role;
  revoke all on public.re_subscriptions from anon, authenticated;
end $$;
