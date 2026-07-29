# Realtika — Real Estate Sales Operations — Working Guide

A **standalone product**: an Express API, its own browser app, and a buyer
portal. It owns its authentication, error handling and scheduled work, and
imports nothing from any other codebase.

```
npm install
cp .env.example .env     # fill in the three required values
npm start                # → http://localhost:4000  (API and app, one process)
```

## Entry point

`server.js` at the repo root. It validates config, builds the Express app,
mounts the API, serves `frontend/`, and listens on `process.env.PORT`.

```
node server.js      ← the start command; also `npm start`
```

There is no `src/app.js`. If a host is configured to run one, it will fail
with "Cannot find module" — point it at `server.js` instead.

## Layout

```
server.js                  boot, middleware, mount, listen
render.yaml                Render blueprint (root dir, Chromium, webhook URL)
src/
  config/env.js            all process.env reads; assertRequired() at boot
  middleware/
    auth.js                HS256 bearer verification → req.user
    orgContext.js          req.user → req.orgId; the shared Supabase client
    errorHandler.js        statusCode-aware; hides 5xx internals in production
  routes/                  thin HTTP layer, one file per resource
    auth.js                register / login / google / reset — NOT authenticated
    webhooks.js            Paystack, verified by HMAC — NOT authenticated
    portal.js              the buyer's own view — portal token, not staff token
  services/                all business logic and provider adapters
  jobs/daily.js            07:00 Africa/Lagos cron
  templates/               allocation letter, receipt
  utils/                   escapeHtml, csv, amountInWords
  test/                    syntax + logic + schema (offline), smoke.js (live)
migrations/                three idempotent SQL files
frontend/
  config.js                sets window.__API_BASE__  ← the one file with a host in it
  index.html               shell: sign-in gate + app
  realestate.css           the whole design system
  realestate.js            session, API, router, UI primitives
  screens.js               every screen
  portal.html/.js          the buyer's self-service page
```

## Request pipeline

```
helmet → cors → rate limit
      → /api/webhooks   express.raw   ← BEFORE express.json, deliberately
      → express.json
      → /health         (no auth)
      → /api/auth       (no auth — these are the endpoints you call to get a token)
      → /api/portal     (portal token, aud:'re-portal')
      → /api/re         authenticate → orgContext → routes
      → frontend/       static
      → 404 → errorHandler
```

**The webhook mount order is load-bearing.** Paystack signs the raw request
bytes; parsing to an object and re-serializing does not round-trip, so moving
`/api/webhooks` below `express.json()` silently breaks every incoming payment.

`authenticate` verifies an HS256 bearer token (algorithm pinned — `alg:none`
and RS256-confusion are rejected) and looks up team membership. `orgContext`
then sets `req.orgId`.

**This service now issues tokens as well as verifying them.** `POST
/api/auth/login` mints the same HS256 token the middleware has always
accepted, so anything else signing with the same `JWT_SECRET` still works
alongside it. Passwords are stored as scrypt verifiers (Node's `crypto`, no
native dependency) — see `src/services/authService.js` for why not bcrypt.

Two token audiences exist and they are **not interchangeable in either
direction**: a staff token has no `aud`, a buyer-portal token carries
`aud: 're-portal'`. `middleware/auth.js` never accepts the second;
`portalService.verifyPortalToken` pins the first out. That is the whole
boundary between "an operator" and "somebody holding a link".

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

Converting a solo workspace to a team (`POST /api/re/settings/team`) rewrites
`organization_id` on every table, because the id itself changes. Without that
backfill the data survives and the dashboard goes blank.

## Deployment

Required env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`. The
process exits at boot if any is missing. Everything else is optional and
degrades:

| Missing | Effect |
|---|---|
| `APP_URL` | Reset and portal links are built relative — set it in production |
| `GOOGLE_CLIENT_ID` | No Google button, and no third-party script is loaded at all |
| `RESEND_API_KEY` | Receipts and alerts are recorded `skipped`, never sent. Visible in Settings → Activity |
| `TERMII_API_KEY` | Same, for SMS |
| `OPENAI_API_KEY` | Brief still runs, rule-based, marked `generated_by: 'fallback'` |
| `PAYSTACK_SECRET_KEY` | Payment links 503; the webhook 503s; bank transfers still work |
| `ALLOWED_ORIGINS` | No browser origin is allowed in production |

Three deployment gotchas, all covered in `render.yaml`:

1. **Root directory.** If the repo holds other projects, point the service at
   the folder containing `server.js`.
2. **Chromium.** Allocation letters and receipts render with headless
   Puppeteer, absent from Render's default Node runtime. Only PDF generation is
   affected — a payment is still recorded and the buyer still emailed, the
   receipt is simply missing. `RE_AUTO_RECEIPTS=false` stops it trying.
3. **The webhook URL.** Point Paystack at
   `https://<service>/api/webhooks/paystack`, or online payments never settle
   the schedule.

The Storage bucket needs no setup — `re-documents` is created privately on
first document generation.

**The frontend's API host lives in exactly one place: `frontend/config.js`.**
Localhost keeps pointing at a local server; everything else uses the
production constant at the top of that file. Nothing else in the app hardcodes
a host.

## Before first use

1. Run `migrations/001_phase1_schema.sql`, then `002_ai_briefs.sql`, then
   `003_operations.sql` in the Supabase SQL editor. `001` is self-contained —
   it creates the identity tables (`users`, `teams`, `team_members`) as well as
   the domain ones, so an empty project is all it needs. All three are
   idempotent, so re-running them after a change is safe and is how you pick up
   the Grants block.

   If the API returns `42501: permission denied for table re_projects`, the
   tables exist but `service_role` holds no privileges on them — re-run all
   three. See the Grants section in `docs/DATABASE.md`.

2. Open the app and **create an account**. That is the whole setup.

`npm run token -- <uuid> <email>` still exists. It is a debugging tool now
rather than the way in — useful for the smoke test, or for signing in as a
user created directly in SQL.

## Testing

```bash
npm test                # syntax (53) + logic (43) + schema (79); no network, no database
npm run test:schema     # migrations against a real in-process Postgres
RE_SMOKE_TOKEN=<jwt> RE_SMOKE_URL=<url> npm run smoke   # URL defaults to localhost:4000/api
```

`test:schema` runs the migrations against PGlite — Postgres compiled to WASM,
so constraints, triggers and RLS are real — applies them twice to prove
idempotency, then asserts every column the application SELECTs by name exists,
and that the database itself refuses a double allocation, a replayed Paystack
reference, a second commission accrual for one payment, a second open promise
on one installment, and a second receipt for one payment.

`npm test` covers what must not silently break: schedules summing to the exact
plan total in kobo, month-end clamping (31 Jan → 28 Feb), timezone
independence, `REINST-` references round-tripping through a UUID, HTML
escaping in generated documents, amounts in words rounding in kobo, CSV
quoting and BOM handling, Nigerian phone normalization, escalation thresholds,
and the rule-based brief.

`npm run smoke` runs the acceptance sequence against a live server: project →
5 units → 2 customers → reservation with a 12-month plan → **second
reservation on the same unit rejected with 409** → payment settles installment
1 → brief generates → dashboard reflects it. It writes real rows named
`Test Estate <timestamp>` — point it at staging.

## Five rules the database enforces, not the code

Unique partial indexes in `migrations/001` and `003`, because the application
must not be the only thing standing between a developer and these:

- one live reservation per unit (double allocation)
- one payment per Paystack reference (webhook replay)
- one commission accrual per payment (paying a rep twice)
- one open promise per installment (a promise stack instead of a latest word)
- one receipt per payment (two receipts for one ₦5m transfer)

## Payments

Paystack references are namespaced `REINST-<schedule-uuid>-<timestamp>`. The
schedule id is itself a UUID containing `-`, so references are parsed by
pattern, never by splitting on the delimiter.

`handleRealEstateCharge(event)` returns `false` for references it does not
own, so `routes/webhooks.js` can be shared with another product on the same
Paystack account without a second endpoint.

**Money arrives by two doors and both call the same thing.** A recorded bank
transfer and a Paystack webhook both end in
`paymentEvents.onPaymentRecorded()`, which accrues commission, renders the
receipt, emails the buyer, closes any open promise, winds back escalation and
writes the audit entry. Nothing in that file throws: the payment is already in
the database, and a failed PDF must not turn a recorded ₦5m into a 500 and a
retried double payment.

Imports are the exception — `routes/imports.js` deliberately does **not** call
it. Emailing 400 buyers a receipt for money they transferred last year is the
worst possible first impression of a product that talks to your buyers for you.

## Deliberately NOT in v1 (do not add)

Buyer/Seller/Mortgage/Legal/Pricing/Market agents, agent orchestration, MLS,
multi-country, marketplace, voice, automatic WhatsApp sending. One AI worker
only: the daily brief plus drafted follow-ups. **Every AI output is a proposal
a human sends** — the escalation stages set the tone of a draft, they never
send it, and a buyer at `legal` stage gets no draft at all. See
`docs/AI_WORKFORCE.md` for the growth path and the gates each future agent
must clear.

## Design

Black and gold: near-black paper (`#090909`), one champagne-gold accent
(`#c9a45c`), warm white text. A private bank's terminal rather than a SaaS
dashboard — the product holds other people's money and is buying trust, so
restraint is the design.

Colour carries state and nothing else: **gold** for what the AI wrote and the
one primary action per screen, **moss** for money in, **clay** for what is
late, dim for everything merely true. Editorial serif for prose (the brief, the
greeting), tabular monospace for every figure so a column of Naira lines up on
the comma.

No glassmorphism, no gradients stacked on gradients, no neon, no floating
robot. The buyer portal shares the palette and typography so it is recognisably
the same company, and shares nothing else.
