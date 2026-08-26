-- ============================================================
-- Sentiment index — AUDIT FIX (Performance #4).
--
-- sentimentService.atRiskSentimentBuyers filters
-- (organization_id, latest_sentiment = 'at_risk') on every workspace's
-- 07:00 daily brief, with no covering index — a full per-org scan of
-- re_customers, growing worse as the buyer list grows (buyers are never
-- deleted). migrations/056's identical "brief reads a derived flag" shape
-- got a dedicated partial index; this one didn't.
--
-- Safe to re-run.
-- ============================================================

create index if not exists idx_re_customers_org_sentiment
  on re_customers(organization_id, latest_sentiment)
  where latest_sentiment = 'at_risk';
