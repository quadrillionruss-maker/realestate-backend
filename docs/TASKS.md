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
- [x] 23 offline logic tests + 14 server checks + an 8-step smoke script

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

## Known gaps

- [ ] No `/api/auth` — this service verifies tokens but does not issue them.
      Whatever handles login must share `JWT_SECRET`.
- [ ] No Paystack webhook route. The handler exists and is idempotent; a route
      that verifies the signature against the raw body still needs mounting if
      Paystack should post here directly (see `docs/API.md`).
- [ ] The frontend redirects to `./index.html` on 401, which assumes a login
      page ships alongside it.

## v1.x (after first real customer feedback)

- [ ] WhatsApp Business API sending (replaces the copy button)
- [ ] Commission tracking per sales rep per payment
- [ ] Receipt PDF auto-generation on payment
- [ ] Customer self-service portal (reuse the portal.html pattern)
- [ ] Promise-to-pay tracking on overdue installments
- [ ] CSV import (buyers + existing schedules) — migrating off Excel is the
      real onboarding
- [ ] Deed of assignment template (`/documents/:id/generate` currently 400s
      for any doc type but `allocation_letter`)

## V2 (gated per AI_WORKFORCE.md — do NOT start early)

- [ ] Deal Manager execution layer (approve → agent acts) + audit log
- [ ] Collections Agent (escalation ladders)
- [ ] Document Agent (signature chasing)
- [ ] Finance/Reporting Agent (investor reports)
- [ ] Sales Agent (lead nurture)

## Business (founder — parallel to build, not after)

- [ ] Demo dataset + 5 developer walkthroughs booked
- [ ] Ask every demo: "What do you use today? Why would you switch?"
- [ ] Pricing validation against the ₦350k/yr anchor
