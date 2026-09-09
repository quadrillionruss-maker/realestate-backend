-- ============================================================
-- Campaign send atomicity — AUDIT FIX (Financial #10).
--
-- send() (campaignService.js) used to check campaign.status === 'sent'
-- once, before starting the whole audience fan-out, with nothing atomically
-- claiming the campaign before messaging began. Two concurrent
-- POST /campaigns/:id/send calls (a double-click, a client retry) could
-- both read status:'draft' and both message the entire audience — every
-- buyer contacted twice, at double the provider cost.
--
-- 'sending' is the atomic claim: send() now does
-- UPDATE ... SET status='sending' WHERE status IN ('draft','scheduled')
-- and only proceeds if a row actually came back, closing the race the same
-- way every other "claim a row before acting on it" pattern in this
-- product already does (see routes/reservations.js's own unit-claim
-- comment for the same technique).
--
-- Safe to re-run.
-- ============================================================

alter table re_campaigns drop constraint if exists re_campaigns_status_check;
alter table re_campaigns add constraint re_campaigns_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent'));

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('065_campaign_sending_status.sql')
  on conflict (filename) do nothing;
