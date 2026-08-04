-- ============================================================
-- PER-WORKSPACE TERMII (SMS) CREDENTIALS
--
-- Same shape and the same reasoning as migrations/017's Paystack
-- keys and migrations/018's Resend keys: until now every
-- workspace's payment reminders and overdue texts went out through
-- ONE platform Termii account and sender ID, so every buyer's text
-- arrived from "Archta" rather than the developer's own registered
-- sender ID.
--
-- termii_api_key_encrypted follows migrations/017's pattern exactly
-- — AES-256-GCM ciphertext, base64 in text, decrypted only in
-- memory when notificationService.js is about to send. Absent on a
-- row = that workspace keeps using the platform's Termii account,
-- unchanged from today.
--
-- termii_sender_id is NOT a secret (it is the visible sender name
-- on every text the workspace sends) and is stored plain, same as
-- paystack_public_key and resend_from_email. It is meaningless
-- without being registered with Termii first — Termii itself
-- refuses to send otherwise, so no validation of that is attempted
-- here.
-- ============================================================

alter table re_org_settings add column if not exists termii_api_key_encrypted text;
alter table re_org_settings add column if not exists termii_api_key_last4     text;
alter table re_org_settings add column if not exists termii_sender_id        text;
