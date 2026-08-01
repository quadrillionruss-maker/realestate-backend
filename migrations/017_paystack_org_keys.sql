-- ============================================================
-- PER-WORKSPACE PAYSTACK KEYS
--
-- Until now every workspace on this deployment shared ONE
-- Paystack account (PAYSTACK_SECRET_KEY, platform-wide). A
-- developer who already has their own Paystack business account
-- could not receive payments into IT — every buyer's transfer
-- went to whoever's key was in the platform's own .env.
--
-- paystack_secret_key_encrypted is AES-256-GCM ciphertext
-- (src/utils/credentials.js), base64 in a text column rather than
-- bytea — see that file's header for why. paystack_secret_key_last4
-- is the plaintext's last four characters ONLY, kept purely so
-- Settings can show "configured, ending in 7f3a" without ever
-- decrypting anything for display.
--
-- paystack_public_key is NOT encrypted: a Paystack public key is
-- meant to be embedded in client-side Paystack.js integrations —
-- treating it as a secret would be backwards.
--
-- Absent on a row = that workspace has not set up its own account
-- yet, and every payment operation for it keeps using the platform
-- key exactly as before. This migration changes nothing about
-- behaviour for a workspace that never touches Settings → Payments.
-- ============================================================

alter table re_org_settings add column if not exists paystack_secret_key_encrypted text;
alter table re_org_settings add column if not exists paystack_secret_key_last4     text;
alter table re_org_settings add column if not exists paystack_public_key          text;
