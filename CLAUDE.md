# Archta — Real Estate Sales Operations — Working Guide

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
render.yaml                Render blueprint (root dir, PDF engine, webhook URL)
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
    recycle.js             delete / restore / bin — the only delete path there is
  services/                all business logic and provider adapters
  jobs/daily.js            07:00 brief + 18:05 post-cutoff sweep (Africa/Lagos)
  templates/               allocation letter, receipt
  utils/                   escapeHtml, csv, amountInWords
  test/                    syntax + logic + schema (offline), smoke.js (live)
migrations/                eight idempotent SQL files, applied in order
frontend/
  config.js                sets window.__API_BASE__
  vercel.json              security headers; CSP connect-src names the same host as config.js
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
`aud: 're-portal'`. `middleware/auth.js` rejects any token with an `aud`;
`portalService.verifyPortalToken` pins the audience the other way. That is the
whole boundary between "an operator" and "somebody holding a link".

**A valid signature is not a live session.** Every staff token carries `tv`,
compared on each request against `users.token_version` (migrations/004).
Bumping that column invalidates every token ever issued to that user at once —
which is what happens on a password change, a password reset, and removal from
a team. Without it, an employee fired on Monday keeps full API access for the
remaining 30 days of their token, and changing their password would not revoke
it either. A token minted before 004 has no `tv` claim and is read as 0, so
deploying the migration does not sign the company out.

The check costs one primary-key read per request. If that ever matters, cache
it — do not remove it. On a database that has not run 004 it fails **open**
with a warning, because a deploy that locks out every user is worse.

## Sign-up and sign-in

**There is no email-verification step, and self-service password reset is
disabled.** Both existed once and both sent mail through Resend; both are off
because this deployment's Resend account is sandboxed to deliver only to its
own owner's address — a confirmation link or a reset link emailed to an actual
buyer or developer would simply never arrive, silently locking them out of an
account they just created or turning "forgot password" into a dead end. Gating
account access on mail that cannot be delivered is worse than not gating it at
all, so `POST /register` (`authService.register`) marks every account
`email_verified_at` immediately and returns a token — the person is signed in
and on the dashboard in the same request, no link to click. `POST
/forgot-password` (`routes/auth.js`) does no work at all: it neither generates
a token nor calls Resend, and answers every request with "Please contact
support to reset your password," which is also what the frontend shows the
moment "Forgot your password?" is clicked, before any request is made.

**This is reversible, not deleted.** `authService.requestPasswordReset` and
`resetPassword`, and `POST /reset-password`, are untouched and still work end
to end — only the route that used to call the first one and email its result
was gutted. Once Resend is on a plan that can actually deliver to a buyer,
restoring self-service reset is rewriting `POST /forgot-password` back to call
`requestPasswordReset` and send the email, not rebuilding the feature. The
email-verification machinery (`issueVerificationToken`, `verifyEmail`, `POST
/verify-email`, `POST /resend-verification`) was removed outright rather than
parked the same way — CLAUDE.md's "Nothing is ever deleted" is about buyer
data, not about every code path a product ever had, and a confirmation flow
with no live caller is a maintenance liability, not a paused feature.
`users.verify_token_hash`/`verify_token_expires_at` remain in the schema,
unused; no migration removed them.

**Every other use of Resend is untouched.** Payment receipts and buyer portal
links (`receiptService`, `portalService`) still send exactly as before —
`notificationService.sendEmail` was not touched by any of this, and neither
was per-workspace Resend configuration (see "Per-workspace credentials"
below). What changed is scoped to the two auth-flow senders that used to call
it: registration's confirmation email and the forgot-password reset email.

## Personal account vs. workspace settings

**Zero overlap, on purpose.** The account button (bottom left of the sidebar,
`btn-account`) opens `realestate.js`'s `openAccountModal()` — a modal covering
only what belongs to the *signed-in person*: photo, name, email, password,
sign out. Settings in the sidebar nav (`R.screens.settings`,
`screens.js`'s `workspaceTab()`) covers only what belongs to the *workspace*:
company branding, the three provider keys (Paystack, Resend, Termii),
notification routing, commission default, and team management under its own
tab. Neither screen shows a field the other one owns. This used to not be
true — the account button navigated straight to `#/settings`, and that
screen's "Your account" and "Sessions" cards edited the caller's own name and
password right next to the workspace's letterhead. That the same click target
(the account button) landed on the same screen as the sidebar's own "Settings"
link was the tell: two different affordances for two different concepts
converging on one screen is a sign they were never actually separated.

**The modal is a single `<form>` with no submit button, deliberately.**
`R.modal()`'s body is always one `<form>` element, and this dialog holds three
independent actions (save profile, change password, sign out) that must not
share one submit — a nested `<form>` isn't valid HTML, so they can't be three
separate forms either. Each action is a `type="button"`, wired individually
with `onClick`, exactly like the Paystack/Email/Termii "test" buttons in
Settings that already share a form with a `type="submit"` Save button and
must not trigger it. What's different here is there is no submit button *at
all* — so `modal()`'s own submit handler, which reads a missing `onSubmit` as
"close the dialog," would otherwise close this one every time Enter was
pressed in any field. `openAccountModal()` passes a no-op `onSubmit` for
exactly that reason: pressing Enter now does nothing, rather than silently
discarding whatever was being typed.

**Changing email or password bumps `token_version`, same as it always did for
password alone.** `PATCH /auth/me` (`routes/auth.js`) now accepts `email` as
well as `full_name`/`company_name`/`password`, gated the same way password
changes always were — an account with a password on file must supply
`current_password` to change *either* one, checked once and shared by both,
since both are ways of taking over who can sign in as this person. A fresh
token comes back either way, for the same reason a password change always
returned one: the caller who just made the change should not be the one
logged out by it.

**Avatar upload mirrors the team logo upload exactly**, one bucket
(`env.storage.publicAssetsBucket`), one size/type ceiling (2MB,
JPEG/PNG/WebP), one function shape — `documentStorage.uploadUserAvatar(userId,
buffer, contentType)` sits right next to `uploadTeamLogo`, keyed by user id
instead of team id so two people in one workspace never collide on a
filename. `POST /auth/me/avatar` is its own rate limiter
(`avatarLimiter`, per-user like the logo's `logoLimiter` is), not the shared
credential limiter — an upload is not a login attempt.

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

## Roles and permissions

Five roles, matching the actual jobs in a Nigerian developer's office —
`owner`, `sales_director`, `sales_rep`, `collections`, `documentation`
(`migrations/016_rbac.sql`). This replaced a generic `owner`/`admin`/`member`
ladder outright: a collections officer is not "an admin who also sells," a
documentation officer must never see what a buyer paid, and a sales
executive must never see another executive's book. `owner  → owner`,
`admin → sales_director`, `member → sales_rep` is the one-time backfill; a
solo account has no `team_members` row at all and reads as `owner` before
and after.

**The rules live in one file, `src/services/permissions.js`, and nowhere
else.** It is pure — no database, no Express — so it is the one thing in
this codebase's access model that is actually unit-tested
(`src/test/logic.test.js`'s "RBAC — permission matrix" section asserts
`canAccess(role, action)` directly, which is equivalent to asserting a route
403s, since that is literally what the route checks). `src/middleware/rbac.js`
is the thin Express adapter: `requirePermission('payments.waive')` mounted
per route, or `assertPermission(req, res, action)` inline where the
permission depends on the request body rather than the path (`PATCH
/commissions/status` is `commissions.approve` for a Sales Director and
`commissions.markPaid` for the owner alone). There is no
`requireRole(['owner','admin'])` helper any more — a route naming its own
role list is a second copy of the access model, and the second copy is the
one that goes stale.

**Row-level filtering is a second, separate question from "can they open
this screen".** `rbac.js`'s `isOwnRecordsOnly(role)` is true only for
`sales_rep`; `salesRepIdsFor(req)` resolves which `re_sales_reps` rows are
this caller, and every "own buyers / own reservations / own commissions"
filter in `routes/customers.js`, `routes/reservations.js`,
`routes/commissions.js`, `routes/documents.js`, `routes/search.js` and
`routes/tasks.js` is built on it. **`re_reservations.sales_rep_id` and
`re_commissions.sales_rep_id` reference `re_sales_reps(id)`, not
`users(id)`** — `re_sales_reps` is its own table with its own id and a
`user_id` pointing at the person. Filtering `sales_rep_id = req.userId`
directly matches nothing at all; the correct filter is two steps, exactly
what `salesRepIdsFor` does. Getting this wrong is the single most
consequential mistake this model can make: a rep either sees the whole
company's book or sees nothing. `re_customers.created_by_user_id`
(`migrations/016`) is the one exception — a buyer is owned by the *user* who
entered them, not by a `re_sales_reps` row, because someone can add a buyer
before an owner has ever tagged them as a rep.

**Documentation never sees a naira figure.** `financial.view` is not a
route gate — it's a content gate checked inside a handler that would
otherwise return money (`routes/customers.js`'s single-customer view strips
`list_price` / `total_amount` / `amount_due` to `null` rather than omitting
the reservation tree outright, so the screen still shows which unit and
which installment is due *when*, just never for how much).

**Invites are a signed link, not a same-request add.**
`src/services/inviteService.js` issues an opaque 32-byte token
(`invite_token`/`invite_expires_at`, `migrations/016`) good for seven days,
emailed via `notificationService.sendEmail`. Someone who already has an
account joins immediately (`status: 'active'` on the same request); someone
who doesn't gets a pending row that grants nothing (`middleware/auth.js`
only ever counts `status: 'active'`) until they register with that address —
`POST /auth/register` calls `claimPendingInvites` by email in the same
request — or accept explicitly via `POST /auth/invite/accept` after signing
in. Only the owner may invite a `sales_director`; a `sales_director` can
build their own team (`sales_rep`, `collections`, `documentation`) but not
appoint a second director (`permissions.canInviteRole`). **Ten workspaces
per person, checked at invite time** (`wouldExceedWorkspaceCap`), because
telling someone "you've been invited" and then refusing them at the door on
click is worse than refusing the invite while whoever sent it is still
looking at the form.

**A person can belong to more than one workspace, and the JWT still carries
no org scope** — that invariant from the token-audience boundary above did
not change. `middleware/auth.js` reads every `active` `team_members` row for
the caller and picks between them using an `X-Workspace-Id` header the
browser sends on every request (`frontend/realestate.js`'s `request()`),
falling back to the oldest membership if the header is absent or names a
workspace they've left — never erroring. `GET /auth/me` returns the full
`workspaces` list (name, role, which one is current) so the sidebar switcher
needs no call of its own, plus `permissions` — the exact `actionsFor(role)`
list `permissions.js` computes server-side — so the browser draws the same
model the API enforces rather than keeping a second copy of the rules by
hand in `screens.js`. Every one of those is presentation only: the frontend
hiding a button does not substitute for the server re-checking the same
permission on the request, which it always does.

## Per-workspace credentials

Three third-party services — Paystack, Resend and Termii — started as one
platform-wide account for every workspace on the deployment.
`PAYSTACK_SECRET_KEY`, `RESEND_API_KEY`/`RESEND_FROM` and
`TERMII_API_KEY`/`TERMII_SENDER_ID` (`.env`) are now a **fallback**, not the
whole story: a workspace can enter its own keys under Settings → Payments,
Settings → Notifications → Email, and Settings → Notifications → SMS, and
every payment operation and every send for that workspace uses them instead
(`migrations/017`, `018`, `019`). Nothing else in the product needs to know
which case it's in — `paystackService.resolvePaystackSecretKey(orgId)`,
`notificationService.resolveResendCredentials(orgId)` and
`notificationService.resolveTermiiCredentials(orgId)` are the three places
that decide, and every caller goes through them.

**A workspace's own secret key is encrypted at rest, never stored plain.**
`src/utils/credentials.js` — AES-256-GCM, so a tampered or truncated
ciphertext (a bit flip in a backup restore, a bug that mangles a column) fails
to decrypt *loudly* instead of silently handing back garbage that then gets
used as an API key. `CREDENTIALS_ENCRYPTION_KEY` (32 bytes, 64 hex chars) is a
separate secret from `JWT_SECRET` — losing it makes every already-stored
workspace key permanently undecryptable, so it needs the same backup
discipline. Public values (`paystack_public_key`, `resend_from_email`,
`termii_sender_id`) are not secrets and are stored plain, same reasoning as
everything else in `re_org_settings`.

**Never returned to the browser once saved.** Settings shows `*_last4` (the
plaintext's last four characters, computed once at save time) plus a
`*_configured` boolean — enough for someone to recognise their own key,
nothing worth stealing if the response ever leaked. The three "test" buttons
(`POST /settings/paystack/test`, `/email/test`, `/termii/test`) all test
whatever is still sitting in the form, not what's already saved, so a typo is
caught before it's committed — Paystack via a read-only transaction-list
call, Resend via an actual test send to the workspace owner's own address
(known — it's `req.user.email`), Termii via an actual test text to a phone
number the form asks for, because unlike an owner's email there is no
account-level phone number on file to default to, and neither provider has a
side-effect-free validity check.

**The webhook is one shared URL, verified against every known key — not the
key the reference names.** `paystackService.verifyWebhookSignature` tries the
platform key plus every workspace's own decrypted key against the incoming
HMAC and trusts nothing about the request body until one of them actually
matches. The alternative — read the `REINST-` reference first, look up which
org it names, verify only against that org's key — was rejected deliberately:
it would let an unauthenticated caller force a database lookup with no proof
of anything, exactly what today's single-key check rejects before touching
the database at all. HMAC-SHA512 against N keys costs microseconds each,
cheap enough at the scale this product actually runs at. One consequence: a
workspace with its own Paystack account still points its dashboard's webhook
at the same shared `/api/webhooks/paystack` URL — nothing to reconfigure.

**A decrypt failure is handled differently depending on what's at stake.**
`resolvePaystackSecretKey` throws rather than silently falling back to the
platform key — charging a buyer's card through the wrong Paystack account
because a workspace's key couldn't be read would settle real money into the
wrong business. `resolveResendCredentials` and `resolveTermiiCredentials`
neither throw — `sendEmail`/`sendSms` never fail the request that triggered
them (the three rules at the top of `notificationService.js`) — but neither
silently falls back to sending as "Archta"; the send is recorded `failed`
with a clear reason, same as any other misconfiguration.

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
| `PAYSTACK_SECRET_KEY` | Payment links 503; the webhook 503s — for any workspace that hasn't set its own Paystack keys. Bank transfers still work |
| `CREDENTIALS_ENCRYPTION_KEY` | A workspace cannot save its own Paystack or Resend keys (those two Settings forms 503) — the platform fallback keeps working exactly as before |
| `ALLOWED_ORIGINS` | No browser origin is allowed in production |

Three deployment gotchas, all covered in `render.yaml`:

1. **Root directory.** If the repo holds other projects, point the service at
   the folder containing `server.js`.
2. **PDF rendering.** Allocation letters and receipts render through
   `puppeteer-core` + `@sparticuz/chromium` — a Chromium build made for exactly
   this kind of constrained Linux host, so no cache directory or separate
   install step is needed. `src/services/pdfAdapter.js` picks this engine by
   **platform**, not `NODE_ENV`: Linux gets `@sparticuz/chromium`, anything
   else (local dev) gets full `puppeteer`, which lives in `devDependencies` and
   is never installed by Render's `npm ci --omit=dev`. `PDF_ENGINE=core|full`
   forces one path if you ever need to diagnose a deploy. If rendering does
   fail, PDF generation is the one thing affected — a payment is still
   recorded and the buyer still emailed, the receipt is simply missing.
   `RE_AUTO_RECEIPTS=false` stops it trying.
3. **The webhook URL.** Point Paystack at
   `https://<service>/api/webhooks/paystack`, or online payments never settle
   the schedule.

The Storage bucket needs no setup — `re-documents` is created privately on
first document generation.

**The frontend's API host lives in `frontend/config.js`.** Localhost keeps
pointing at a local server; everything else uses the production constant at
the top of that file.

**`frontend/vercel.json` also names that same backend origin**, in the
Content-Security-Policy header's `connect-src` (the frontend is deployed on
Vercel separately from the API, hence its own header config rather than
`server.js`'s helmet setup). A CSP that doesn't list the API's real origin
there blocks every fetch to it outright — the browser refuses the request
before it leaves the page, which reads as "the app is broken" with nothing
useful in the Network tab pointing at *why*. When the production domain
changes, `connect-src` in `frontend/vercel.json` needs the same update
`frontend/config.js` does — JSON has no comment syntax to leave a note
in-file, which is why this paragraph is where that note lives instead.

## Before first use

1. Run every file in `migrations/`, in numeric order, in the Supabase SQL
   editor — `001_phase1_schema.sql` through the highest-numbered file present
   (`019_termii_org_keys.sql` as of this writing). `001` is self-contained — it creates
   the identity tables (`users`, `teams`, `team_members`) as well as the
   domain ones, so an empty project is all it needs. Every migration is
   idempotent, so re-running the whole set after a change is safe and is how
   you pick up a new Grants block.

   If the API returns `42501: permission denied for table re_projects`, the
   tables exist but `service_role` holds no privileges on them — re-run the
   whole set. See the Grants section in `docs/DATABASE.md`.

2. Open the app and **create an account** — you are signed in immediately and
   land on the dashboard. See "Sign-up and sign-in" below for why there is no
   confirmation email to click.

`npm run token -- <uuid> <email>` still exists. It is a debugging tool now
rather than the way in — useful for the smoke test, or for signing in as a
user created directly in SQL.

## Testing

```bash
npm test                # syntax + logic + schema; no network, no database
npm run test:schema     # migrations against a real in-process Postgres
RE_SMOKE_TOKEN=<jwt> npm run smoke                      # defaults to localhost:4000/api
```

`npm run smoke` **refuses to run against a non-localhost URL** unless
`RE_SMOKE_CONFIRM` names the host *and* today's date, as `<host>:<YYYY-MM-DD>`.
It writes real rows — a project, five units, two buyers, a reservation and a
₦3.75m payment — and pointed at production those land in a developer's actual
inventory and their actual collected-this-month figure. The date is part of
the value, not just the host, so a confirmation left exported in a shell
profile goes stale on its own instead of silently authorizing every run from
then on.

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

## Nothing is ever deleted

There is no hard delete anywhere in this API. A delete stamps `deleted_at`,
cascades to children through the explicit map in
`src/services/softDelete.js`, and the rows stay in the database and the audit
log permanently. `POST /api/re/recycle/:resource/:id/restore` brings them back.

**The live filter is applied in `middleware/orgContext.js`, not per query.**
`supabaseAdmin.from(t).select(...)` on any soft-deletable table comes back
already scoped to `deleted_at is null`. There are ~150 query sites and the
hundred-and-fiftieth is the one somebody forgets, so forgetting is not
possible. It touches reads only — writes address rows by id, and the restore
path has to be able to write to a deleted row.

`supabaseRaw` is the unfiltered client. `softDelete.js` is its only legitimate
caller.

Two tables have no `deleted_at` at all: `re_audit_log` and `re_notifications`.
A nullable column there would imply the evidence can be withdrawn.

**Embedded resources are not filtered** — `re_reservations(re_customers(...))`
scopes the reservations, not the nested customers. The cascade is what covers
that: deleting a buyer deletes their reservations, so a live parent with a
deleted child is not a reachable state. A future table that breaks that
assumption needs an explicit filter.

## Data retention, and what that means for a buyer's own data

"Nothing is ever deleted" (above) is a data-integrity guarantee — a receipt or
an allocation letter must survive to settle a dispute years later — and it has
a direct consequence: `re_customers` rows, once created, are retained
indefinitely. A "delete" from the product's own UI is a soft delete; the row,
its name, phone and email stay in the database and in every backup, restorable
by design.

**There is currently no automated path that honours a buyer's request to be
forgotten.** A developer operating in Nigeria is subject to the NDPA (Nigeria
Data Protection Act) the same way a GDPR-covered business is subject to the
right to erasure — and today, satisfying that request means someone with
direct database access running a deliberate hard delete against `supabaseRaw`,
outside the application entirely. That is a manual, one-off operation, not a
feature — treat it as an open gap, not a solved problem, until an actual
erasure path is built.

**Logs are a second place PII can end up, separately from the database.**
`re_notifications` intentionally records every email/SMS attempt including its
recipient (see "Nothing is ever deleted" above — it has no `deleted_at`), which
is the audit trail doing its job. Application logs (`console.error` and
friends, which end up in Render's log retention) are a different matter: a raw
driver error's `.detail`/`.hint` can quote an offending row's actual column
values verbatim, so error-logging call sites should log `err.message` (written
for a human, never carries row data), not the raw error object. This is why
`routes/webhooks.js`'s catch blocks do that rather than `console.error(...,
err)` — the pattern is deliberate, not incidental, and worth matching in new
code that logs a caught driver error.

## Due dates are 18:00 Africa/Lagos

An installment due on a date is due by **6pm on that date**, close of business.
`src/services/overdueService.js` is the only place that decides it —
`overdueThroughDate()`, `isPastDue()` and `describeDue()` — and the sweep, the
brief, the alerts, the reminders and the promise tracker all read it from there.
`RE_DUE_CUTOFF_HOUR` moves it; there is one value for the whole workspace,
because two cutoffs is the same as none.

`jobs/daily.js` therefore runs **twice**: 07:00 for the brief and the alerts,
and 18:05 for a marking-only sweep. Without the evening run an installment that
missed its deadline reads as "pending" for another thirteen hours, and a rep
looking at the screen at 7pm is told the money is still coming.

Buyer-facing wording comes from `describeDue()` ("30 Jul 2026 by 6pm"), so
nobody is held to a cutoff they were never told.

## Seven rules the database enforces, not the code

Unique partial indexes in `migrations/001`, `003`, `004` and `007`, because the
application must not be the only thing standing between a developer and these:

- one live reservation per unit (double allocation)
- one payment per Paystack reference (webhook replay)
- one commission accrual per payment (paying a rep twice)
- one open promise per installment (a promise stack instead of a latest word)
- one receipt per payment (two receipts for one ₦5m transfer)
- one allocation letter per reservation (three letters for one unit, disagreeing)
- one **active** plan per reservation (two schedules counting the same debt)
- one reallocation per overpaid payment (`migrations/007`) — the same credit
  spent onto two different installments by two concurrent clicks

An overpayment (`re_payments.overpayment`, `migrations/004`) is real money
already recorded, not yet assigned. Moving it onto a different installment
(`POST /payments/:paymentId/reallocate`) writes a **new** payment row rather
than editing the old one — the paid history stays exactly as it happened —
but marks it `reallocated_from_payment_id` so `commissionService` does not
pay the rep twice on the same transfer, and so every "total paid" sum
excludes it rather than counting that money a second time.

Regenerating any document is still fine — it rewrites the same row and the same
storage path. What that rule forbids is a second row, i.e. a second letter with
its own reference number.

**Every one of these indexes carries `deleted_at is null`** (migrations/005).
Without it a soft-deleted reservation would block its unit forever, and a
deleted allocation letter would make a replacement impossible. `npm run
test:schema` asserts both that double allocation is still refused and that a
soft-deleted reservation releases the unit — that pair is the regression to
watch if the predicate is ever touched.

## Renegotiating a plan

`POST /api/re/reservations/:id/restructure` supersedes the current plan and
builds a new one for the remaining balance. The old plan and its paid rows stay
exactly as they were, because the buyer's receipts refer to them; its unpaid
rows are set to `waived` so they stop counting as owed.

The new plan's `total_amount` is the **balance**, not the contract value —
`installmentService` guarantees the schedule sums to the plan total to the kobo
and that invariant is worth more than field convenience. The contract survives
as `original_total_amount = carried_amount_paid + total_amount`. Read contract
value through `restructureService.contractValue()` so nothing has to know
whether a plan was ever restructured.

## Rental tenancies

A reservation is `property_type`: `off_plan` (default), `outright` or
`rental` (migrations/006). Existing reservations were backfilled to
`off_plan`, so nothing already in the product changed shape.

**A rental's monthly-rent schedule is an installment plan, not a new
concept.** `total_amount = monthly_rent × duration_months`,
`number_of_installments = duration_months`, `frequency = 'monthly'` —
`installmentService` builds it unmodified, which is why rentals needed no
change to the plan or schedule tables at all, only to the reservation
(`tenancy_start_date`, nullable `tenancy_end_date` for an open-ended lease).

**Renewal is restructuring's sibling, not its reuse.** Both supersede the
expiring plan and create a new one (`uniq_re_active_plan_per_reservation`,
migrations/005, allows exactly one active plan either way), but a renewal
carries forward **nothing** — no balance, no `original_total_amount` — because
it is a fresh lease term, not a renegotiation of an existing debt. Paid rows,
their receipts and the whole prior schedule are left exactly as they were.
`rentalService.renewTenancy()`; `POST /api/re/reservations/:id/renew-tenancy`.

**60 days before `tenancy_end_date`, the morning job files a task** (`source:
'ai'`, same as every brief recommendation) asking whether to renew or end the
tenancy — `rentalService.checkTenancyRenewals()`, run once for every org
alongside the other 07:00 sweeps. It never renews anything itself: every AI
output here is a proposal a human acts on, and extending a lease is a
commercial decision, not a reminder.

The brief tells a tenant 30 days late on rent apart from a buyer who missed an
off-plan installment — "rent", not "installment"; "Tenancy Agreement", not
"Contract of Sale" — via `aiBrief.termsFor()`, read from `property_type` on
each row. Both the rule-based fallback and the OpenAI system prompt carry the
same distinction, so a model outage does not change which noun a tenant reads.

## Payments

Paystack references are namespaced `REINST-<schedule-uuid>-<timestamp>`. The
schedule id is itself a UUID containing `-`, so references are parsed by
pattern, never by splitting on the delimiter.

`handleRealEstateCharge(event)` returns `false` for references it does not
own, so `routes/webhooks.js` can be shared with another product on the same
Paystack account without a second endpoint.

Which Paystack account a given payment actually settles into — the platform's
or a workspace's own — and how the shared webhook verifies either, is covered
in "Per-workspace credentials" above.

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

**A payment can be voided, never deleted or edited.** `POST
/api/re/payments/:paymentId/void` (owner or sales director only, `migrations/008`) marks a
wrongly-entered payment `voided_at`/`void_reason` — the row, its amount and its
timestamp stay exactly as originally entered, because it is still a financial
fact, just no longer a live one. Voiding recomputes the installment it applied
to (`paystackService.applyPaymentsToSchedule` is bidirectional for exactly
this: a schedule row can drop back out of `paid` to `pending`/`overdue`, the
one case where a payment's effect is ever removed) and voids the commission it
earned, if any. Every place "how much has this buyer paid" gets computed —
`applyPaymentsToSchedule`, `initInstallmentPayment`'s outstanding-balance
check, `recordManualPayment`/`reallocateOverpayment`'s overpayment math,
`receiptService`/`portalService`'s totals, `restructureService`'s carried
balance, the dashboard and reports — filters `voided_at is null`. The
`GET /payments` ledger and the CSV export deliberately do not: a voided entry
stays visible there, dimmed, next to the correction, because a complete record
is the point.

## Deliberately NOT in v1 (do not add)

Buyer/Seller/Mortgage/Legal/Pricing/Market agents, agent orchestration, MLS,
multi-country, marketplace, voice, automatic WhatsApp sending. One AI worker
only: the daily brief plus drafted follow-ups. **Every AI output is a proposal
a human sends** — the escalation stages set the tone of a draft, they never
send it, and a buyer at `legal` stage gets no draft at all. See
`docs/AI_WORKFORCE.md` for the growth path and the gates each future agent
must clear.

## Frontend gotchas that have already bitten once

**`[hidden]` needs the `!important` rule at the top of the stylesheet.** The
browser hides `[hidden]` elements through its own stylesheet, and *any* author
`display` declaration beats a UA one — specificity does not enter into it. So
`.gate { display: grid }` on `<main class="gate" hidden>` left the sign-in page
fully visible, stacked above the app shell in one 200vh document. Every
show/hide in this app uses the attribute, so that rule is load-bearing. Do not
give a hideable element a `display` value expecting `hidden` to win.

**Re-rendering must not scroll.** `renderRoute` compares a route *signature*
(name + params + query) and only blanks to a skeleton and jumps to the top when
the screen actually changes. Every mutation calls `reload()`, and on the
payments screen that used to mean clicking "Record" on row 40 and being returned
to row 1.

**Phone numbers go through `R.waLink()`.** `wa.me` needs `234803…` with no
leading zero; stripping non-digits from `08031234567` produces a link WhatsApp
opens and then rejects.

**Downloads go through `R.openFile()`,** which clicks a real anchor. Mobile
popup blockers drop `window.open` when the call is an `await` away from the tap
— and every one of ours is, because the signed URL has to be fetched first.

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
