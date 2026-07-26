# Architecture

## Current (v1) — a standalone service

```
Static frontend                    Node/Express (Render)
┌──────────────────────┐  HTTPS    ┌────────────────────────────────────┐
│ realestate.html      │──────────▶│ server.js                          │
│  + .css / .js        │           │  helmet → cors → rate limit → json │
└──────────────────────┘           │  /health          (no auth)        │
   bearer token in                 │  /api/re → authenticate            │
   Authorization header            │           → orgContext             │
                                   │           → routes/ (thin HTTP)    │
                                   │              └─ services/ (logic)  │
                                   │  jobs/daily (07:00 Africa/Lagos)   │
                                   └──────┬───────────────┬─────────────┘
                                          │               │
                              Supabase (Postgres,   External adapters:
                              Storage)              Paystack · OpenAI ·
                                                    Puppeteer
```

The API has no runtime dependency on any other codebase. It verifies bearer
tokens rather than issuing them, so it can sit alongside a separate service
that owns login as long as both share `JWT_SECRET` — but it boots, runs and
deploys entirely on its own.

## Principles

- **Market-agnostic core, country modules.** Nothing in the schema is
  Nigeria-specific except defaults (₦, Africa/Lagos, WhatsApp-first drafts).
  A future market is a new adapter set plus config, not a rewrite.
- **Adapters everywhere.** `paystackService`, `aiBrief` (OpenAI) and
  `pdfAdapter` (Puppeteer) are the only files that know a provider exists.
  Swapping one is a single-file change.
- **Routes are thin.** Business logic lives in services so future agents can
  call the same functions the HTTP layer does.
- **One place decides who you are.** `middleware/auth.js` verifies the token;
  `middleware/orgContext.js` turns that into `req.orgId`. No route re-derives
  identity.
- **Explicit org filtering, RLS as the second lock.** The service-role client
  bypasses RLS, so every query filters `organization_id` explicitly. RLS is
  enabled with no policies — deny-by-default — because a policy written
  against `auth.uid()` would evaluate to NULL for these tokens and read as
  protection that does not exist. See `docs/DATABASE.md`.
- **The database enforces what the application must not get wrong.** One live
  reservation per unit and one payment per Paystack reference are unique
  partial indexes, not just code paths.
- **Namespaced payment references** (`REINST-*`) mean the Paystack handler can
  share an account and a webhook with another product without a second
  endpoint: it returns false for references it does not own.
- **Degrade, don't fail.** The morning brief is the product's daily heartbeat.
  Without an OpenAI key, or when the model errors, it falls back to a
  rule-based summary and drafts and marks itself `generated_by: 'fallback'`
  rather than skipping the morning. Missing Paystack keys 503 the payment-link
  endpoint while bank-transfer recording keeps working.

## Failure posture

Boot fails loudly and immediately when `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` or `JWT_SECRET` is absent — a service that starts
without them would only fail on the first real request. Everything optional
degrades in a way the UI can show. `/health` reports database reachability so
the platform can pull a broken deploy, and SIGTERM drains in-flight requests
so a payment being recorded during a deploy is not dropped.

## Evolution path (documented in AI_WORKFORCE.md)

brief job → Deal Manager (execution + approvals + audit log) → specialist
agents as service modules registered with the Deal Manager. The `re_tasks`
table (`source` column) and `re_ai_briefs.payload` (jsonb) are the seams where
orchestration grows without migration pain. Today the brief *reads* state and
*drafts* actions; every output is a proposal a human sends.
