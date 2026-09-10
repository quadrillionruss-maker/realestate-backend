-- ============================================================
-- AUDIT FIX (P11-P13) — three daily sweeps run PLATFORM-WIDE (jobs/daily.js
-- calls each with no orgId, scanning every organization's rows in one
-- query), but every existing index on the columns each one filters by
-- leads with organization_id — which does not appear as a predicate in any
-- of these three queries at all, so none of them can actually be used the
-- way each was presumably intended to be. A leading column with no
-- predicate on it does not narrow a Postgres index scan; each of these
-- queries has been a sequential scan of the WHOLE table, across every
-- workspace on the platform, since the day it shipped.
--
-- re_contractor_payments — contractorService.sweepOverdueContractorPayments:
--   .eq('status', 'pending').lt('due_date', today), no org filter at all.
--   The existing idx_re_contractor_payments_org_status (organization_id,
--   status) and idx_re_contractor_payments_project (project_id, due_date)
--   migrations/036 both need a predicate this query never supplies.
--
-- re_documents — documentService.sweepExpiredDocuments:
--   .in('status', [...]).lt('expires_at', now), no org filter. The existing
--   idx_re_documents_expiry (organization_id, expires_at) migrations/042
--   has the identical problem — that index's own comment even names the
--   sweep as its reason for existing.
--
-- re_reservations — rentalService.checkTenancyRenewals:
--   .eq('property_type','rental').lte('tenancy_end_date', horizon), no org
--   filter. idx_re_reservations_tenancy_end (organization_id,
--   tenancy_end_date) migrations/006 has the same problem, and that
--   migration's own comment shows the mismatch plainly: it describes "a
--   sequential scan of every reservation in the WORKSPACE" as the thing
--   being prevented, but the function it backs has always been called with
--   no orgId, scanning every workspace at once.
--
-- None of the three original indexes are dropped — an org-scoped read of
-- any of these columns may exist elsewhere and still benefit from them.
-- These are additions, leading with the column each sweep actually filters
-- by, so the sweep itself finally has an index it can use.
--
-- Safe to re-run.
-- ============================================================

create index if not exists idx_re_contractor_payments_status_due
  on re_contractor_payments(status, due_date)
  where status = 'pending';

create index if not exists idx_re_documents_expiry_sweep
  on re_documents(expires_at)
  where expires_at is not null and status in ('generated', 'sent');

create index if not exists idx_re_reservations_tenancy_end_sweep
  on re_reservations(tenancy_end_date)
  where property_type = 'rental' and tenancy_end_date is not null and deleted_at is null;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('088_platform_sweep_indexes.sql')
  on conflict (filename) do nothing;
