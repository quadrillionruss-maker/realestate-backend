-- ============================================================
-- Buyer sentiment analysis — SECTION 13 (feature expansion).
--
-- re_sentiment_cache is deliberately NOT scoped by organization_id — the
-- question it answers ("has this exact message text been classified
-- before") does not depend on which developer's buyer sent it, only on the
-- words themselves, so one workspace's classification of "thank you so
-- much!" as positive is equally valid cache for every other workspace's
-- identical message. It stores a HASH and a one-word label only, never the
-- message text or which buyer/org sent it — no cross-tenant data exposure,
-- the same reasoning that makes a content-addressed cache safe to share.
--
-- Safe to re-run.
-- ============================================================

alter table re_customers add column if not exists latest_sentiment text
  check (latest_sentiment is null or latest_sentiment in ('positive', 'neutral', 'concerned', 'at_risk'));

create table if not exists re_sentiment_cache (
  message_hash text primary key,
  sentiment text not null check (sentiment in ('positive', 'neutral', 'concerned', 'at_risk')),
  created_at timestamptz not null default now()
);

alter table re_sentiment_cache enable row level security;
drop policy if exists "org members access re_sentiment_cache" on re_sentiment_cache;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_sentiment_cache to service_role;
  revoke all on public.re_sentiment_cache from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('062_sentiment.sql')
  on conflict (filename) do nothing;
