-- ============================================================
-- AUDIT FIX (D1) — soft-delete cascade gaps.
--
-- Every table below is a genuine child of a buyer, a reservation or a joint
-- sale (each carries the FK to prove it) that shipped after migrations/005
-- wired up soft-delete without ever being added to the cascade: deleting the
-- buyer or reservation they hang off left them live forever, readable
-- through every screen and export that queries them directly, disagreeing
-- with a parent the product now says is gone. None of them had a deleted_at
-- column at all — this migration adds it, and src/middleware/orgContext.js's
-- SOFT_DELETABLE / src/services/softDelete.js's CHILDREN map (same commit)
-- do the auto-filtering and the actual cascade.
--
-- re_community_posts and re_community_replies already carry deleted_at
-- (migrations/037) and are not touched here — only the cascade wiring in
-- softDelete.js and orgContext.js was missing for them.
--
-- NOT included, deliberately — see softDelete.js's own comment for the
-- reasoning on each: re_attendance, re_log_entries (migrations/055 says so
-- explicitly), re_campaigns/re_campaign_deliveries (org-level, not a child
-- of one buyer/reservation/project), re_email_templates, re_receipt_templates,
-- re_push_subscriptions, re_sessions (all user/workspace-level, not buyer/
-- reservation/project children), re_recovery_playbook, re_developer_dna,
-- re_feature_events (computed/aggregate, org-level only) and
-- re_ai_conversations (migrations/078 documents this one as permanent,
-- same reasoning as re_audit_log).
--
-- Safe to re-run.
-- ============================================================

alter table re_legal_cases add column if not exists deleted_at timestamptz;
alter table re_financing_requests add column if not exists deleted_at timestamptz;
alter table re_hardship_requests add column if not exists deleted_at timestamptz;
alter table re_messages add column if not exists deleted_at timestamptz;
alter table re_scheduled_messages add column if not exists deleted_at timestamptz;
alter table re_satisfaction_surveys add column if not exists deleted_at timestamptz;
alter table re_customer_referrals add column if not exists deleted_at timestamptz;

-- re_joint_sales/re_joint_sale_parties (migrations/059) are guarded by an
-- existence check rather than a plain `alter table`, unlike every other
-- statement above: src/test/schema.test.js's migration-apply loop does not
-- run migrations 055-072 at all (a pre-existing, documented gap — see that
-- file's own note), so in THAT simulated database these two tables do not
-- exist yet. In every real deployment 059 has already run by the time this
-- file does (CLAUDE.md's "in numeric order"), so the `if exists` is always
-- true there and this behaves exactly like the plain form above.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 're_joint_sales') then
    alter table re_joint_sales add column if not exists deleted_at timestamptz;
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 're_joint_sale_parties') then
    alter table re_joint_sale_parties add column if not exists deleted_at timestamptz;
  end if;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('083_soft_delete_cascade_expansion.sql')
  on conflict (filename) do nothing;
