-- ============================================================
-- ONE OPEN AI TASK PER TITLE, PER ORG
--
-- aiBrief.fileRecommendationsAsTasks() already checks for an existing
-- open 'ai'-sourced task with the same title before inserting — but a
-- check-then-insert has a race window, and this table has no lock
-- standing behind it the way an installment schedule or a Paystack
-- reference does. A brief regenerated manually while the scheduled
-- 07:00 run is still filing the same recommendations both pass the
-- check before either has inserted, and the CEO gets a duplicate task
-- for the same follow-up.
--
-- Scoped to source = 'ai' and status = 'open', matching the
-- application's own check exactly: a human-created task or a resolved
-- AI task with the same title is not a duplicate.
-- ============================================================

create unique index if not exists uniq_re_tasks_open_ai_title
  on re_tasks(organization_id, title)
  where source = 'ai' and status = 'open' and deleted_at is null;
