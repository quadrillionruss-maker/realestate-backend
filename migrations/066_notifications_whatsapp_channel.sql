-- ============================================================
-- re_notifications.channel missing 'whatsapp' — DISCOVERED WHILE FIXING NF3.
--
-- migrations/003 created re_notifications with
-- `channel text not null check (channel in ('email','sms'))`, written before
-- WhatsApp sending existed in this product. notificationService.sendWhatsApp
-- and sendWhatsAppDocument have always recorded `channel: 'whatsapp'` —
-- which the check constraint rejects outright. record()'s own try/catch
-- swallows the insert failure and only logs a console.warn, so this has
-- been failing silently since the WhatsApp features shipped: every
-- WhatsApp send this product has ever made — receipts, payment links,
-- campaign messages, collections nudges — is missing from re_notifications
-- entirely. That breaks the admin dashboard's notification stats (WhatsApp
-- undercounted in "by_type"), and it breaks NF3's own throttle (which reads
-- this table to tell "did we just send this buyer a payment link" — it
-- would never find one to throttle against).
--
-- Widening the constraint, not narrowing anything — no existing row is
-- affected, and nothing downstream assumed 'whatsapp' could never appear.
--
-- Safe to re-run.
-- ============================================================

alter table re_notifications drop constraint if exists re_notifications_channel_check;
alter table re_notifications add constraint re_notifications_channel_check
  check (channel in ('email', 'sms', 'whatsapp'));
