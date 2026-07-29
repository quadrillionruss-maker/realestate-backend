# Architecture

## Current (v1) — a standalone service

```
Browser                            Node/Express (Render)
┌──────────────────────┐  HTTPS    ┌─────────────────────────────────────┐
│ index.html           │──────────▶│ server.js                           │
│  config.js           │           │  helmet → cors → rate limit         │
│  realestate.css/.js  │           │  /api/webhooks  raw body, HMAC      │
│  screens.js          │           │  ── express.json ──                 │
├──────────────────────┤           │  /health        (no auth)           │
│ portal.html/.js      │──────────▶│  /api/auth      (no auth)           │
└──────────────────────┘           │  /api/portal → portal token         │
   staff token, or a               │  /api/re     → authenticate         │
   signed portal link              │              → orgContext           │
                                   │              → routes/ (thin HTTP)  │
Paystack ─────────────────────────▶│                 └─ services/ (logic)│
   charge.success, HMAC-signed     │  frontend/      static              │
                                   │  jobs/daily (07:00 Africa/Lagos)    │
                                   └──────┬───────────────┬──────────────┘
                                          │               │
                              Supabase (Postgres,   External adapters:
                              Storage)              Paystack · OpenAI ·
                                                    Puppeteer · Resend · Termii
```

The API has no runtime dependency on any other codebase. It both issues and
verifies bearer tokens, so it can still sit alongside a separate service that
owns login as long as both share `JWT_SECRET` — but it boots, runs, serves its
own UI and deploys entirely on its own.

**The webhook mount sits above `express.json()` deliberately.** Paystack signs
the raw request bytes, and parsing then re-serializing does not round-trip.
That one line of ordering is the difference between online payments settling
and staff re-typing every card payment by hand.

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
  identity. A buyer-portal token is a *different* audience (`aud: 're-portal'`)
  and is refused by that middleware outright — a link forwarded to the wrong
  person can never become an operator session.
- **Money has one door on the inside.** A recorded bank transfer and a Paystack
  webhook both end in `paymentEvents.onPaymentRecorded()`, so the receipt, the
  commission accrual, the buyer's email and the audit entry do not depend on
  which button an admin pressed. Nothing in that file throws: the payment is
  already committed, and a failed PDF must not turn it into a 500 and a
  retried double payment.
- **The log is evidence, so nothing can edit it.** `re_audit_log` has no
  foreign keys (rows outlive the user who made them) and no write, update or
  delete route. Property disputes here end up in front of lawyers.
- **Explicit org filtering, RLS as the second lock.** The service-role client
  bypasses RLS, so every query filters `organization_id` explicitly. RLS is
  enabled with no policies — deny-by-default — because a policy written
  against `auth.uid()` would evaluate to NULL for these tokens and read as
  protection that does not exist. See `docs/DATABASE.md`.
- **The database enforces what the application must not get wrong.** One live
  reservation per unit, one payment per Paystack reference, one commission per
  payment, one open promise per installment and one receipt per payment are
  unique partial indexes, not just code paths.
- **Namespaced payment references** (`REINST-*`) mean the Paystack handler can
  share an account and a webhook with another product without a second
  endpoint: it returns false for references it does not own.
- **Degrade, don't fail.** The morning brief is the product's daily heartbeat.
  Without an OpenAI key, or when the model errors, it falls back to a
  rule-based summary and drafts and marks itself `generated_by: 'fallback'`
  rather than skipping the morning. Missing Paystack keys 503 the payment-link
  endpoint while bank-transfer recording keeps working. Missing Resend or
  Termii keys record the send as `skipped` in `re_notifications` rather than
  failing the payment that triggered it — and "skipped" is a different word
  from "sent" on the Activity screen, so a silent product is visible.

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
