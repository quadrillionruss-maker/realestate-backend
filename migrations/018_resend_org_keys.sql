-- ============================================================
-- PER-WORKSPACE RESEND (EMAIL) CREDENTIALS
--
-- Same shape and the same reasoning as migrations/017's Paystack
-- keys: until now every workspace's receipts, portal links and
-- alerts went out through ONE platform Resend account, so every
-- buyer received email that said "Archta" rather than the
-- developer's own name and domain.
--
-- resend_api_key_encrypted follows migrations/017's pattern
-- exactly — AES-256-GCM ciphertext, base64 in text, decrypted only
-- in memory when notificationService.js is about to send. Absent
-- on a row = that workspace keeps using the platform's Resend
-- account, unchanged from today.
--
-- resend_from_email is NOT a secret (it is the visible "From"
-- address on every email the workspace sends) and is stored plain,
-- same as paystack_public_key. It is meaningless without a Resend
-- account that has verified the domain it belongs to — Resend
-- itself refuses to send otherwise, so no validation of that is
-- attempted here.
-- ============================================================

alter table re_org_settings add column if not exists resend_api_key_encrypted text;
alter table re_org_settings add column if not exists resend_api_key_last4     text;
alter table re_org_settings add column if not exists resend_from_email        text;
