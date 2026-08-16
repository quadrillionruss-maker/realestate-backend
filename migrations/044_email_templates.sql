-- ============================================================
-- Customizable email content — SECTION 14.
--
-- One row per (organization_id, template_type) — a workspace either has a
-- saved override for a type or it doesn't; there is no history of past
-- versions the way re_documents now has (migrations/043), because an email
-- template isn't evidence of anything that happened, just the current
-- wording of something that hasn't been sent yet.
--
-- {{buyer_name}}, {{amount}}, {{unit}}, {{due_date}}, {{portal_link}} are
-- substituted at send time — src/services/notificationService.js's
-- resolveEmailContent() is the one place that reads this table; a template
-- type with no saved row here falls straight through to the built-in email
-- that type has always sent.
--
-- receipt, portal_link and document_ready are wired into a live send today.
-- overdue_reminder and welcome are configurable here but not yet wired to
-- an automatic send — see notificationService.js's own comment on why.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_email_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  template_type text not null check (template_type in ('receipt', 'portal_link', 'overdue_reminder', 'document_ready', 'welcome')),
  subject varchar(200) not null,
  body_html text not null check (char_length(body_html) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, template_type)
);

create index if not exists idx_re_email_templates_org on re_email_templates(organization_id);

alter table re_email_templates enable row level security;
drop policy if exists "org members access re_email_templates" on re_email_templates;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_email_templates to service_role;
  revoke all on public.re_email_templates from anon, authenticated;
end $$;
