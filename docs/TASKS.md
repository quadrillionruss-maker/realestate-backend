# Tasks

## Build — done

- [x] Schema with deny-by-default RLS and integrity indexes for
      double-allocation and webhook replay
- [x] Full API under `/api/re`: projects, units, customers, sales reps,
      reservations, payments, documents, tasks, dashboard, brief
- [x] Atomic unit claim (conditional UPDATE + unique partial index) so two
      simultaneous requests cannot double-allocate
- [x] Kobo-precise, timezone-independent installment schedules
- [x] Paystack adapter: namespaced `REINST-*` references, idempotent handler
- [x] Allocation letters → Puppeteer → private Storage bucket → signed URLs
- [x] Daily brief with a rule-based fallback when OpenAI is unavailable
- [x] **Standalone server**: `server.js`, own HS256 auth, error handler,
      health check, CORS (with `PATCH`), rate limiting, graceful shutdown
- [x] `render.yaml` blueprint; `.env.example`
- [x] Offline logic + schema test suite (`npm test`, 553 checks as of this
      writing) + an 8-step smoke script (`npm run smoke`)

## Operational — for you

- [ ] Run `migrations/001` then `002` in the Supabase SQL editor (`001` is
      self-contained — it creates `users`, `teams` and `team_members` too, so
      an empty project is all it needs)
- [ ] Insert your first user and mint a token (`npm run token`) — every
      endpoint requires one, and a fresh database has none
- [ ] Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET` on the host
      (the service refuses to boot without them)
- [ ] Set `ALLOWED_ORIGINS` to the frontend's origin — in production no
      browser origin is allowed by default
- [ ] Set `OPENAI_API_KEY` (optional; without it the brief falls back)
- [ ] Confirm the host's start command is `node server.js` and its root
      directory is the folder containing it
- [ ] Deploy and run `npm run smoke` against staging

## Known gaps — STALE, see below

This section described the state at initial v1 launch. All three items it
listed are done and have been for a while:

- `/api/auth` exists (`src/routes/auth.js`) — register, login, Google,
  password reset, invite accept. See CLAUDE.md's "Sign-up and sign-in".
- The Paystack webhook route is mounted (`src/routes/webhooks.js`, verified
  against the raw body, ahead of `express.json()` in `server.js` — see
  CLAUDE.md's "Request pipeline" for why that ordering is load-bearing).
- The frontend does not redirect to `./index.html` on 401. `realestate.js`'s
  `request()` calls `signOut()` in place and falls back to the sign-in gate
  already in the DOM (see CLAUDE.md's "Frontend gotchas" on why `[hidden]`
  toggling, not navigation, is how that gate shows and hides).

For current behaviour, CLAUDE.md and `docs/API.md` are authoritative; the
"Build — done" section above and the roadmap sections below predate most of
what actually shipped (RBAC, per-workspace credentials, rentals, e-signature,
construction tracking, credit scoring, the buyer portal, and everything else
CLAUDE.md documents) and are kept here only as a historical record of the
original v1 scope, not a current gap list.

## v1.x (all shipped)

Every item below was still open when this list was written; all are now live
— kept for history, not as outstanding work:

- [x] Commission tracking per sales rep per payment (`migrations/020`)
- [x] Receipt PDF auto-generation on payment (`receiptService`)
- [x] Customer self-service portal (`routes/portal.js`, `frontend/portal.html`)
- [x] Promise-to-pay tracking on overdue installments (`routes/promises.js`)
- [x] CSV import (`routes/imports.js`)
- [x] Deed of assignment template — along with `subscriber_agreement` and
      `power_of_attorney` (`migrations/027`, `SIGNABLE_DOC_TYPES` in
      `documentService.js`). `lease_agreement` is the one doc_type on the
      enum that still has no template and returns `{ unsupported: true }`
      (`documentService.js`'s own SECTION 8 comment) — `receipt` and
      `allocation_letter` render via their own dedicated paths.
- [x] WhatsApp messaging — scheduled sends (`migrations/049`,
      `scheduledMessageService.js`) and the V2 agents below send directly
      once a workspace has WhatsApp configured (see `docs/AI_WORKFORCE.md`).
      The plain copy-button fallback still exists for workspaces that don't.

## V2 (see docs/AI_WORKFORCE.md for current status)

`docs/AI_WORKFORCE.md`'s own status line supersedes the "do NOT start early"
gate this section originally shipped with. All five agents plus the Deal
Manager that gatekeeps them are implemented and run from `src/jobs/daily.js`
(`migrations/028`); a workspace only gets actual sends once WhatsApp is
configured for it, otherwise it gets proposals only, same as v1 — see
`docs/AI_WORKFORCE.md`'s architecture rule #3.

- [x] Deal Manager + per-action audit log (`dealManager.js`)
- [x] Collections Agent — escalation ladders, promise tracking (`collectionsAgent.js`)
- [x] Document Agent — signature chasing (`documentAgent.js`)
- [x] Finance/Reporting Agent — investor reports (`financeAgent.js`)
- [x] Sales Agent — lead nurture (`salesAgent.js`)
- [x] Market Intelligence Agent (`marketIntelAgent.js`) — not in the original
      v1.x list above, added since

## Business (founder — parallel to build, not after)

- [ ] Demo dataset + 5 developer walkthroughs booked
- [ ] Ask every demo: "What do you use today? Why would you switch?"
- [ ] Pricing validation against the ₦350k/yr anchor
