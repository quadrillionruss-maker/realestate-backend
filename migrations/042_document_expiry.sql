-- ============================================================
-- Document expiry tracking — SECTION 9.
--
-- expires_at is set once, at generation time (documentService.generateDocument),
-- to 90 days out — a generated-but-never-signed legal document sitting
-- indefinitely is exactly the kind of thing that quietly goes stale until a
-- dispute surfaces it. The daily sweep (documentService.sweepExpiredDocuments,
-- run from jobs/daily.js after the brief) files one task per document that
-- has crossed its own expires_at while still 'generated' or 'sent' — never
-- 'signed' or 'pending', which read as either resolved or not yet a document
-- to chase at all.
--
-- Nullable, not backfilled: an existing document generated before this
-- migration has no expiry (null reads as "never expires" everywhere this
-- column is checked), rather than every already-issued letter in the
-- workspace's history suddenly reading as overdue the moment this ships.
--
-- Safe to re-run.
-- ============================================================

alter table re_documents add column if not exists expires_at timestamptz;

-- The sweep's own query shape: status in ('generated','sent') and
-- expires_at in the past, scoped to org. Partial — most documents are
-- either not yet generated (no expires_at) or long since resolved, so this
-- only ever indexes the ones actually worth scanning.
create index if not exists idx_re_documents_expiry
  on re_documents(organization_id, expires_at)
  where expires_at is not null and status in ('generated', 'sent');
