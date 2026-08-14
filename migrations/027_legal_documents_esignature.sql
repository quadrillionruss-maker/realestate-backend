-- ============================================================
-- Legal document automation + e-signature — SECTION 8.
--
-- Two new doc_types join deed_of_assignment (accepted since 001, never
-- implemented until now) on the same enum: subscriber_agreement,
-- power_of_attorney. lease_agreement (006) and allocation_letter/receipt
-- are unaffected — the signing flow below only ever applies to the three
-- "the buyer must countersign this contract" types, never to an
-- informational letter or a receipt.
--
-- storage_path (existing) keeps pointing at the UNSIGNED rendered PDF —
-- what the buyer is asked to read before signing — and signed_storage_path
-- is a SEPARATE object once they do, never an overwrite of the original.
-- The reasoning is the same one documentService.js already gives for
-- timestamping every regeneration onto its own path: the exact bytes a
-- buyer actually read and signed have to survive, unaltered, for as long as
-- the contract might ever be disputed.
--
-- The signing link itself is a JWT (aud:'re-document-sign'), the exact same
-- shape portalService.issuePortalToken already uses for a buyer's account
-- link — signed with JWT_SECRET, self-verifying, nothing stored in the
-- database for it at all. What replaces "revoke the link" here is simpler
-- than the portal's token_version bump: once signed_at is set, the document
-- has done its one job and a still-valid token for it is rejected on that
-- basis (documentService.verifySigningToken) — a legal document only ever
-- needs signing once, unlike a portal link a buyer reopens for months.
--
-- Safe to re-run.
-- ============================================================

do $$
begin
  alter table re_documents drop constraint if exists re_documents_doc_type_check;
  alter table re_documents
    add constraint re_documents_doc_type_check
    check (doc_type in (
      'allocation_letter', 'deed_of_assignment', 'lease_agreement',
      'subscriber_agreement', 'power_of_attorney', 'receipt', 'other'
    ));
exception when check_violation then
  raise exception 're_documents has a row with a doc_type outside the expected set — check before re-running';
end $$;

alter table re_documents add column if not exists signed_at timestamptz;
-- Text, not inet: a signing link is opened by a buyer's own phone or
-- laptop, from wherever they happen to be — this is a record of where the
-- signature was captured from, the same evidentiary role a wet-ink
-- signature's witnessed location plays, not a value anything queries or
-- indexes on.
alter table re_documents add column if not exists signed_ip text;
-- A data:image/png;base64,... string (drawn) or the buyer's typed full name
-- (typed) — see signature_type. Never re-derived from signed_storage_path:
-- the PDF is what gets shown to people, this is the raw evidence a dispute
-- would actually need.
alter table re_documents add column if not exists signature_data text;
alter table re_documents add column if not exists signature_type text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_documents_signature_type_check') then
    alter table re_documents add constraint re_documents_signature_type_check
      check (signature_type is null or signature_type in ('drawn', 'typed'));
  end if;
end $$;
alter table re_documents add column if not exists signed_storage_path text;

-- One row per (organization_id, doc_type) — the owner's own replacement for
-- the shipped default template text. Absent means "use the default" (see
-- src/templates/*.html); present and null-ish is never a valid state this
-- product produces, so documentService.js's fallback logic never has to
-- treat "a row exists but is empty" as a third case.
create table if not exists re_document_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  doc_type text not null check (doc_type in ('deed_of_assignment', 'subscriber_agreement', 'power_of_attorney')),
  template_html text not null,
  updated_at timestamptz not null default now(),
  unique (organization_id, doc_type)
);

alter table re_document_templates enable row level security;
drop policy if exists "org members access re_document_templates" on re_document_templates;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_document_templates to service_role;
  revoke all on public.re_document_templates from anon, authenticated;
end $$;
