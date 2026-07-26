# Architecture

## Current (v1, integrated)

```
Static frontend                    Railway (Node/Express)
┌──────────────────────┐  HTTPS    ┌──────────────────────────────────┐
│ index.html (FlowDesk)│──────────▶│ FlowDesk routes                  │
│ portal.html          │           │ /api/re/* ── authenticate ──┐    │
│ realestate.html (new)│           │   src/re/                   │    │
└──────────────────────┘           │    ├─ routes/   (thin HTTP) │    │
   shares localStorage.fd_token    │    ├─ services/ (logic +    │    │
   own visual identity             │    │             adapters)  │    │
                                   │    └─ jobs/daily (07:00 WAT)│    │
                                   └──────┬──────────────┬───────┘    │
                                          │              │
                            Supabase (Postgres, Storage)  External adapters:
                                                          Paystack · OpenAI ·
                                                          Puppeteer (FlowDesk's)
```

No bundler: FlowDesk's frontend is static HTML served as-is, so the real
estate screen is a plain page with a `<script>` tag, not a Vite entry point.

## Principles

- **Market-agnostic core, country modules.** Nothing in the schema is
  Nigeria-specific except defaults (₦, Africa/Lagos, WhatsApp-first drafts).
  A future market is a new adapter set plus config, not a rewrite.
- **Adapters everywhere.** `paystackService`, `aiBrief` (OpenAI) and
  `pdfAdapter` are the only files that know a provider exists. Swapping one is
  a single-file change. `pdfAdapter` also insulates the module from *where* it
  lives: it uses FlowDesk's Puppeteer service when grafted, its own browser
  when standalone.
- **Routes are thin.** Business logic lives in services so future agents can
  call the same functions the HTTP layer does.
- **Explicit org filtering, RLS as the second lock.** The service-role client
  bypasses RLS, so every server query filters `organization_id` explicitly.
  RLS is enabled with no policies — deny-by-default — because FlowDesk's own
  JWT means `auth.uid()` is NULL and a policy written against it would be
  decorative. See `docs/DATABASE.md`.
- **The database enforces what the application must not get wrong.** One live
  reservation per unit and one payment per Paystack reference are unique
  partial indexes, not just code paths.
- **Namespaced payment references** (`REINST-*`) let FlowDesk invoicing and
  real estate installments share one Paystack account and one verified
  webhook.
- **Degrade, don't fail.** The morning brief is the product's daily heartbeat.
  Without an OpenAI key, or when the model errors, it falls back to a
  rule-based summary and drafts and marks itself `generated_by: 'fallback'`
  rather than skipping the morning.

## Evolution path (documented in AI_WORKFORCE.md)

brief job → Deal Manager (execution + approvals + audit log) → specialist
agents as service modules registered with the Deal Manager. The `re_tasks`
table (`source` column) and `re_ai_briefs.payload` (jsonb) are the seams where
orchestration grows without migration pain. Today the brief *reads* state and
*drafts* actions; every output is a proposal a human sends.
