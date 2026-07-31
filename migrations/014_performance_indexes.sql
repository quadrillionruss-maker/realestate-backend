-- ============================================================
-- TWO QUERIES THAT HAD NO INDEX SHAPED FOR THEM
--
-- 1. promiseService.sweepBrokenPromises() runs TWICE a day (07:00 and
--    18:05, jobs/daily.js) and deliberately queries every organization in
--    ONE call — filtering only on (status, promised_date), no
--    organization_id at all, because looping the sweep per-org would just
--    be N round trips for no benefit. The existing index
--    (organization_id, status, promised_date) is useless here: Postgres
--    cannot use a composite btree index without its leading column, so
--    this was a full table scan across every org's promises, every run.
--
-- 2. GET /api/re/commissions (routes/commissions.js) filters on
--    organization_id and orders by created_at descending — the one shape
--    that existed for re_commissions was (organization_id, sales_rep_id)
--    and (organization_id, status), neither of which helps an ORDER BY.
-- ============================================================

create index if not exists idx_re_promises_status_date
  on re_payment_promises(status, promised_date)
  where deleted_at is null;

create index if not exists idx_re_commissions_org_created
  on re_commissions(organization_id, created_at desc);
