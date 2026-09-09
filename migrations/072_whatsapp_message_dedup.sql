-- ============================================================
-- WhatsApp inbound message dedup — AUDIT FIX (New Features #12).
--
-- No dedup by WhatsApp's own message id existed before this: if Meta ever
-- redelivers the same webhook payload (a network retry, a multi-subscription
-- edge case), the identical inbound message would be processed a second
-- time — a second real Paystack transaction and a second WhatsApp send for
-- one "PAY" from one buyer. Low probability (the route already acks with
-- 200 before processing, which is the main trigger for a Meta retry in the
-- first place), but there was no safety net if it happened.
--
-- No organization_id: a WAMID is already globally unique across the whole
-- WhatsApp platform, and this table exists purely to answer "have we ever
-- seen this exact message id before" — the same reasoning re_sentiment_cache
-- (migrations/062) gives for its own cross-tenant, no-org-scope design.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_processed_whatsapp_messages (
  message_id text primary key,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert on public.re_processed_whatsapp_messages to service_role;
  revoke all on public.re_processed_whatsapp_messages from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('072_whatsapp_message_dedup.sql')
  on conflict (filename) do nothing;
