-- ============================================================
-- Campaign delivery "skipped" status — AUDIT FIX (Data Integrity #2).
--
-- send() (campaignService.js) treated anything that wasn't a confirmed
-- send as a failure: a legitimate skip (no email/phone on file, opted out
-- of WhatsApp, provider not configured for this workspace) was written as
-- status:'failed' because this table's check constraint had no 'skipped'
-- value. A campaign sent to a list where 30% simply have no email on file
-- reported "30% failed" — reading as a delivery problem when nothing
-- actually failed, and burying genuine failures in the same bucket.
--
-- Safe to re-run.
-- ============================================================

alter table re_campaign_deliveries drop constraint if exists re_campaign_deliveries_status_check;
alter table re_campaign_deliveries add constraint re_campaign_deliveries_status_check
  check (status in ('pending', 'sent', 'delivered', 'failed', 'opened', 'skipped'));

alter table re_campaigns add column if not exists skipped_count integer not null default 0;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('069_campaign_delivery_skipped.sql')
  on conflict (filename) do nothing;
