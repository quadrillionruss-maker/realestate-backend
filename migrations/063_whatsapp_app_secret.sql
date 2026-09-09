-- ============================================================
-- WhatsApp inbound webhook signature verification — AUDIT FIX (Security #1).
--
-- The inbound WhatsApp webhook (routes/webhooks.js POST /whatsapp) verified
-- nothing about the request body — anyone who knew a workspace's
-- phone_number_id (visible to that workspace's own owner in Settings, not a
-- secret) could forge an inbound message claiming to be from any phone
-- number, including a real buyer's, and silently opt them out or trigger a
-- real Paystack payment-link send in their name.
--
-- Meta's Cloud API signs every webhook delivery with HMAC-SHA256 of the raw
-- body, keyed by the App Secret, sent as X-Hub-Signature-256 — but only if
-- the receiving App has an App Secret configured on Meta's side in the
-- first place, which is a credential this product has never collected.
-- This column is that credential, stored the same way every other
-- per-workspace provider secret in this table already is: AES-256-GCM
-- encrypted (src/utils/credentials.js), decrypted only at verification
-- time, never returned to the browser once saved.
--
-- Nullable, same reasoning as every other optional per-workspace secret:
-- a workspace that has not yet entered one keeps working exactly as before
-- (unverified) rather than being locked out the moment this ships.
--
-- Safe to re-run.
-- ============================================================

alter table re_org_settings add column if not exists whatsapp_app_secret_encrypted text;
-- Same "*_last4 plus a *_configured boolean" convention every other secret
-- in this table already follows (CLAUDE.md's "Per-workspace credentials") —
-- enough for someone to recognise their own secret, nothing worth stealing
-- if the response ever leaked.
alter table re_org_settings add column if not exists whatsapp_app_secret_last4 text;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_org_settings to service_role;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('063_whatsapp_app_secret.sql')
  on conflict (filename) do nothing;
