-- ============================================================
-- re_commissions reservation index — AUDIT FIX (Performance #6).
--
-- jointSaleService.myJointSaleCommissions filters
-- (organization_id, reservation_id IN (...)) with no covering index —
-- a pre-existing gap commissionService.js's own leaderboard query already
-- had; this new call site inherits the same scaling limit. Postgres could
-- only narrow by org via an existing index and then scan the rest of that
-- org's commission history in memory for the reservation match.
--
-- Safe to re-run.
-- ============================================================

create index if not exists idx_re_commissions_org_reservation
  on re_commissions(organization_id, reservation_id);
