-- ============================================================
-- Receipt header/footer customization — SECTION 5.
--
-- Narrower than the legal-document template override (re_document_templates,
-- migrations/027): a receipt is evidence of money received, so the parts
-- that actually state what happened — the amount, the receipt number, the
-- installment breakdown, the balance — are never editable, only the
-- letterhead (header_html) and the closing disclaimer/contact block
-- (footer_html) around them. One row per workspace, same shape as every
-- other single-row-per-org settings table.
--
-- header_html/footer_html are raw, owner-authored HTML rendered into the
-- receipt PDF as-is, not escaped — the same trust boundary
-- re_document_templates.template_html already established for legal
-- documents: this is the WORKSPACE OWNER writing their own letterhead, not
-- buyer-supplied text, so it is trusted the same way.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_receipt_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique,
  header_html text check (char_length(header_html) <= 2000),
  footer_html text check (char_length(footer_html) <= 1000),
  show_logo boolean not null default true,
  show_developer_address boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table re_receipt_templates enable row level security;
drop policy if exists "org members access re_receipt_templates" on re_receipt_templates;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_receipt_templates to service_role;
  revoke all on public.re_receipt_templates from anon, authenticated;
end $$;
