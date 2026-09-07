-- ============================================================
-- AI Business Intelligence Assistant — SECTION 6 of the intelligence/
-- outcome-tracking/AI assistant feature expansion. re_ai_conversations is
-- the transcript: one row per question asked and answered, the exact
-- context snapshot that answer was grounded in, and which category
-- detectQuestionCategory (src/services/aiAssistantService.js) resolved it
-- to — so a disputed or confusing answer can be reproduced and audited
-- after the fact rather than trusted on faith.
--
-- context_snapshot is the sanitized context object actually sent to
-- OpenAI, the same "what the model saw" record aiBrief.js keeps nowhere
-- persistently (the brief only stores its OWN output) — here it is kept
-- because a conversation is interactive and a follow-up question needs to
-- be checked against what the assistant already said, not just what it
-- currently says.
--
-- No deleted_at — same reasoning re_audit_log/re_notifications/
-- re_agent_actions already established (CLAUDE.md's "Nothing is ever
-- deleted"): a conversation with the AI about a workspace's own money is
-- exactly the kind of record that stays, not one a soft-delete cascade
-- should ever need to hide.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_ai_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  question text not null,
  answer text not null,
  question_category text not null check (question_category in (
    'collections', 'buyers', 'projects', 'sales', 'documents', 'executive'
  )),
  context_snapshot jsonb not null default '{}'::jsonb,
  tokens_used integer,
  generated_by text not null default 'model' check (generated_by in ('model', 'fallback')),
  created_at timestamptz not null default now()
);

create index if not exists idx_re_ai_conversations_org_created on re_ai_conversations(organization_id, created_at desc);

alter table re_ai_conversations enable row level security;
drop policy if exists "org members access re_ai_conversations" on re_ai_conversations;

-- Proactive insights — the chat bubble's own unread indicator. One row per
-- daily check (jobs/daily.js, after the brief) that actually found
-- something worth surfacing; a quiet day files nothing, same "nothing
-- renders rather than a placeholder" convention as everywhere else in this
-- feature expansion. dismissed_at is set either when the owner/director
-- clicks it (opens the assistant with `question` pre-filled) or explicitly
-- dismisses it — either way it stops counting toward "unread".
create table if not exists re_ai_proactive_insights (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  message text not null,
  question text not null,
  trigger_reason text not null check (trigger_reason in (
    'collections_drop', 'project_health_drop', 'new_overdue_surge', 'high_score_buyer_missed_payment'
  )),
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_ai_proactive_insights_org_open
  on re_ai_proactive_insights(organization_id, created_at desc) where dismissed_at is null;

alter table re_ai_proactive_insights enable row level security;
drop policy if exists "org members access re_ai_proactive_insights" on re_ai_proactive_insights;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert on public.re_ai_conversations to service_role;
  revoke all on public.re_ai_conversations from anon, authenticated;
  grant select, insert, update on public.re_ai_proactive_insights to service_role;
  revoke all on public.re_ai_proactive_insights from anon, authenticated;
end $$;
