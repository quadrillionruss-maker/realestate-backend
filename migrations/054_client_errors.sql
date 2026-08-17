-- ============================================================
-- Client-side error reporting — visibility for the platform admin into a
-- bug like the one that shipped in SECTION 15 (a var referenced before its
-- own assignment left RE.whatsappQueue undefined, throwing on every
-- dashboard render) — invisible to anyone but the one person who hit it and
-- happened to have devtools open, until now.
--
-- Deliberately NOT a re_* org-scoped table filtered through orgContext.js's
-- deleted_at convention — this is telemetry, same footing as re_admin_actions
-- (migrations/040) and re_agent_actions: platform-wide, no RLS policy, only
-- the admin dashboard ever reads it, nothing in the operator app queries it
-- back. organization_id/user_id are nullable on purpose: a bug that fires
-- before a session exists (rare, but possible) still has to be reportable.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_client_errors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  user_id uuid,
  -- Which of this product's three separate frontends threw — they share no
  -- code (see CLAUDE.md's Layout section), so a bug in one says nothing
  -- about the other two.
  app text not null default 'operator' check (app in ('operator', 'admin', 'portal')),
  message text not null,
  stack text,
  screen text,
  url text,
  user_agent text,
  created_at timestamptz not null default now(),
  -- Set once, by the admin, once the underlying bug is actually fixed — not
  -- a soft-delete. The SAME error firing again after this is set inserts a
  -- fresh, unresolved row (see clientErrorService.js), which is what makes
  -- a fix that didn't actually work visible again automatically instead of
  -- silently staying "resolved".
  resolved_at timestamptz
);

create index if not exists idx_re_client_errors_created on re_client_errors(created_at);
create index if not exists idx_re_client_errors_unresolved on re_client_errors(app, screen, message) where resolved_at is null;

alter table re_client_errors enable row level security;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_client_errors to service_role;
  revoke all on public.re_client_errors from anon, authenticated;
end $$;
