-- ============================================================
-- TOTP two-factor authentication — SECTION 2.
--
-- Owner role only (src/services/permissions.js enforces this at setup time,
-- not here — a workspace with no team_members row at all is always "owner"
-- and this column set means nothing different for a director or a rep, so
-- there is no role check a CHECK constraint could meaningfully express).
--
-- totp_secret_encrypted uses the SAME AES-256-GCM helper
-- (src/utils/credentials.js) a workspace's own Paystack/Resend keys
-- already use — a TOTP secret has to be handed back to speakeasy in
-- plaintext on every login to verify a code, so it needs the same
-- reversible-but-authenticated encryption a Paystack key does, not the
-- one-way hash password_hash uses (that only ever needs comparing, never
-- reading back).
--
-- totp_backup_codes are the opposite: eight single-use recovery codes,
-- generated once at enrollment and shown to the owner exactly that one
-- time, so they are HASHED (scryptKey, the same one-way function
-- password_hash already uses) rather than encrypted — this server never
-- needs to read one back, only ever compare an entered code against what
-- is stored, and losing the ability to display them again is deliberate:
-- if this table were ever read by someone who should not have it, a
-- reversible encryption of eight standing bypass codes would be far worse
-- than a reversible encryption of one TOTP seed.
--
-- Safe to re-run.
-- ============================================================

alter table users add column if not exists totp_secret_encrypted text;
alter table users add column if not exists totp_enabled boolean not null default false;
alter table users add column if not exists totp_backup_codes jsonb not null default '[]'::jsonb;
