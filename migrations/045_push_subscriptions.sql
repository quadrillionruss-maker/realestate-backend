-- ============================================================
-- Browser push notifications — SECTION 1.
--
-- One row per (browser, device) a user has granted permission on — the same
-- person on their phone and their desktop holds two subscriptions, both
-- live, both notified. endpoint is the push service's own unique URL for
-- that subscription (FCM/Mozilla/etc.), which is why it — not user_id — is
-- the natural per-row identity: re-subscribing the same browser after
-- clearing site data yields a NEW endpoint, and the old one simply stops
-- being deliverable to (the push service answers 404/410, handled by
-- pushService.js dropping the row rather than retrying forever).
--
-- organization_id is denormalized here the same way it is on every other
-- table, even though user_id alone would resolve it via a join — every
-- push send is scoped to "notify org X's owner", and filtering the send
-- query by organization_id directly is one WHERE clause instead of a join
-- through users/team_members on every send.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  organization_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_push_subscriptions_org_user on re_push_subscriptions(organization_id, user_id);

alter table re_push_subscriptions enable row level security;
drop policy if exists "org members access re_push_subscriptions" on re_push_subscriptions;

-- The topbar bell's own in-app log — separate from re_push_subscriptions
-- above on purpose. A browser push (via web-push) is only deliverable to a
-- device that granted OS-level permission; the bell has to work for
-- everyone regardless, the same way an app's own notification centre
-- always does even before you ever say yes to a push prompt. One row per
-- TARGETED USER per event (not per subscription/device), written by
-- pushService.notify() for all four trigger events — payment recorded,
-- brief generated, new overdue buyer, hardship request submitted — so a
-- fifth trigger added later gets the bell for free just by calling the
-- same function.
create table if not exists re_push_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  organization_id uuid not null,
  title text not null,
  body text,
  url text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

-- The bell's own query: "my unread, newest first".
create index if not exists idx_re_push_notifications_user_unread
  on re_push_notifications(user_id, created_at desc)
  where read_at is null;
create index if not exists idx_re_push_notifications_user_all
  on re_push_notifications(user_id, created_at desc);

alter table re_push_notifications enable row level security;
drop policy if exists "org members access re_push_notifications" on re_push_notifications;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_push_subscriptions to service_role;
  revoke all on public.re_push_subscriptions from anon, authenticated;

  grant select, insert, update on public.re_push_notifications to service_role;
  revoke all on public.re_push_notifications from anon, authenticated;
end $$;
