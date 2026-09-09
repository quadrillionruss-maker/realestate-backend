-- ============================================================
-- Message specificity — SECTION 3 of the intelligence/outcome-tracking/AI
-- assistant feature expansion ("by message type — when specific amounts
-- are mentioned vs generic reminders").
--
-- Nullable, and left null for almost everything. This is only ever set
-- where outcomeService.classifyMessageSpecificity actually has real
-- message TEXT to look at (a WhatsApp/campaign/SMS body containing a naira
-- figure is 'specific'; the same without one is 'generic') — call_logged,
-- promise_recorded and restructure_offered carry no message text at all
-- and are never classified. A guess based on which service sent a message,
-- with no look at what it actually said, would be exactly the "fabricated
-- intelligence" this whole feature expansion was commissioned to avoid.
--
-- Safe to re-run.
-- ============================================================

alter table re_action_outcomes add column if not exists message_specificity text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_action_outcomes_message_specificity_check') then
    alter table re_action_outcomes
      add constraint re_action_outcomes_message_specificity_check
      check (message_specificity is null or message_specificity in ('specific', 'generic'));
  end if;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('075_message_specificity.sql')
  on conflict (filename) do nothing;
