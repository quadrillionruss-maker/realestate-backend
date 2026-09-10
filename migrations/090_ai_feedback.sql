-- ============================================================
-- AI recommendation feedback — a thumbs up/down under every Archta
-- Intelligence answer (frontend/realestate.js's ai-chat drawer). The signal
-- for "which types of questions Archta answers well vs poorly" — question/
-- answer/feedback are the whole of that signal; question_category isn't
-- duplicated here because it can always be re-derived from the linked
-- conversation row (conversation_id) when a category breakdown is needed.
--
-- ── conversation_id ────────────────────────────────────────────────────────
-- Nullable and on delete set null: this links back to the exact
-- re_ai_conversations row this vote is about (aiAssistantService.askAssistant
-- now returns that row's own id as conversation_id specifically so the
-- frontend can send it back here) — without it, a piece of feedback could
-- never be traced to the actual context/model/category that produced it,
-- only to whatever question/answer text the client happened to still have
-- in memory. Nullable because a vote on a FALLBACK answer (the model never
-- ran) has no conversation row to reference.
--
-- Not soft-deletable — same reasoning re_action_outcomes/re_client_errors
-- already establish: a small, permanent signal table, not a live record a
-- soft-delete cascade should ever need to hide.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_ai_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid references users(id) on delete set null,
  conversation_id uuid references re_ai_conversations(id) on delete set null,
  question text not null,
  answer text not null,
  feedback text not null check (feedback in ('positive', 'negative')),
  created_at timestamptz not null default now()
);

create index if not exists idx_re_ai_feedback_org_created on re_ai_feedback(organization_id, created_at desc);

alter table re_ai_feedback enable row level security;
drop policy if exists "org members access re_ai_feedback" on re_ai_feedback;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert on public.re_ai_feedback to service_role;
  revoke all on public.re_ai_feedback from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('090_ai_feedback.sql')
  on conflict (filename) do nothing;
