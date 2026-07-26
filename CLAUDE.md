# Real Estate Sales Operations API — Working Guide

A **standalone backend**. It owns its authentication, error handling and
scheduled work, and imports nothing from any other codebase.

```
npm install
cp .env.example .env     # fill in the three required values
npm start                # → http://localhost:4000
```

## Entry point

`server.js` at the repo root. It validates config, builds the Express app,
mounts the API and listens on `process.env.PORT`.

```
node server.js      ← the start command; also `npm start`
```

There is no `src/app.js`. If a host is configured to run one, it will fail
with "Cannot find module" — point it at `server.js` instead.

## Layout

```
server.js                  boot, middleware, mount, listen
render.yaml                Render blueprint (root dir + Chromium notes)
src/
  config/env.js            all process.env reads; assertRequired() at boot
  middleware/
    auth.js                HS256 bearer verification → req.user
    orgContext.js          req.user → req.orgId; the shared Supabase client
    errorHandler.js        statusCode-aware; hides 5xx internals in production
  routes/                  thin HTTP layer, one file per resource
  services/                all business logic and provider adapters
  jobs/daily.js            07:00 Africa/Lagos cron
  templates/               allocation letter
  test/                    logic.test.js (offline), smoke.js (live)
migrations/                two idempotent SQL files
frontend/                  the Sales Operations screen
```

## Request pipeline

```
helmet → cors → rate limit → express.json
      → /health (no auth)
      → /api/re → authenticate → orgContext → routes
      → 404 → errorHandler
```

`authenticate` verifies an HS256 bearer token (algorithm pinned — `alg:none`
and RS256-confusion are rejected) and looks up team membership. `orgContext`
then sets `req.orgId`.

**This service verifies tokens, it does not issue them.** Whatever handles
login must sign with the same `JWT_SECRET` and include `id` in the payload.
If you later want it to own login too, that is a new `/api/auth` route plus a
users table — nothing in the current design blocks it.

## Org scoping

`organization_id = user.team_id ?? user.id`. It points at a team for team
accounts and at the user for solo ones, which is why it carries no foreign
key. Every table has the column and every query filters it explicitly, because
the service-role client bypasses RLS by design. RLS is enabled with **no
policies** — deny-by-default — so the anon key can read nothing even if it
leaks. See `docs/DATABASE.md` for why a policy on `auth.uid()` would be
decorative here.

Team lookup degrades to "solo account" if there is no `team_members` table, so
the service runs against a database that only has the `re_*` tables.

## Deployment

Required env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`. The
process exits at boot if any is missing. Everything else is optional and
degrades:

| Missing | Effect |
|---|---|
| `OPENAI_API_KEY` | Brief still runs, rule-based, marked `generated_by: 'fallback'` |
| `PAYSTACK_SECRET_KEY` | Payment links 503; recording bank transfers still works |
| `ALLOWED_ORIGINS` | No browser origin is allowed in production |

Two deployment gotchas, both covered in `render.yaml`:

1. **Root directory.** If the repo holds other projects, point the service at
   the folder containing `server.js`.
2. **Chromium.** Allocation letters render with headless Puppeteer, which is
   absent from Render's default Node runtime. Only PDF generation is affected;
   the rest of the API is unaffected.

The Storage bucket needs no setup — `re-documents` is created privately on
first document generation.

## Before first use

Run `migrations/001_phase1_schema.sql` then `migrations/002_ai_briefs.sql` in
the Supabase SQL editor. Both are idempotent.

## Testing

```bash
npm test                                          # 23 logic tests, offline
RE_SMOKE_TOKEN=<jwt> RE_SMOKE_API=<url> npm run smoke
```

`npm test` covers what must not silently break: schedules summing to the exact
plan total in kobo, month-end clamping (31 Jan → 28 Feb), timezone
independence, `REINST-` references round-tripping through a UUID, HTML
escaping in the allocation letter, and the rule-based brief.

`npm run smoke` runs the acceptance sequence against a live server: project →
5 units → 2 customers → reservation with a 12-month plan → **second
reservation on the same unit rejected with 409** → payment settles installment
1 → brief generates → dashboard reflects it. It writes real rows named
`Test Estate <timestamp>` — point it at staging.

## Two rules the database enforces, not the code

Both are unique partial indexes in `migrations/001`, because the application
must not be the only thing standing between a developer and these:

- one live reservation per unit (double allocation)
- one payment per Paystack reference (webhook replay)

## Payments

Paystack references are namespaced `REINST-<schedule-uuid>-<timestamp>`. The
schedule id is itself a UUID containing `-`, so references are parsed by
pattern, never by splitting on the delimiter.

`handleRealEstateCharge(event)` is exported from
`src/services/paystackService.js` and returns `false` for references it does
not own, so it can be called from a webhook shared with another product
without a second endpoint. This service does not currently expose a webhook
route of its own; add one that verifies the Paystack signature before calling
the handler if you need Paystack to post here directly.

## Deliberately NOT in v1 (do not add)

Buyer/Seller/Mortgage/Legal/Pricing/Market agents, agent orchestration, MLS,
multi-country, marketplace, voice, in-app WhatsApp sending. One AI worker
only: the daily brief plus drafted follow-ups. Every AI output is a proposal a
human sends. See `docs/AI_WORKFORCE.md` for the growth path and the gates each
future agent must clear.

## Design

The frontend is a warm "morning dispatch" almanac — paper stock, hairline
rules, editorial serif for prose, tabular monospace for money. Colour encodes
state: clay for what's late, brass for what the AI wrote, moss for money in.
It is its own product with its own identity, not a themed variant of anything
else.
