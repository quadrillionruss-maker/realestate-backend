# Real Estate Module — Integration Guide

A module grafted onto the existing FlowDesk codebase, not a new app. FlowDesk
already has auth, teams, Paystack (with constant-time HMAC webhook
verification), Resend, Puppeteer PDF generation and Supabase Storage.
**All of it is reused. None of it was rebuilt.**

## Status: integrated

The graft is done in `c:\Users\quadr\Desktop\flowdesk-backend`. What remains is
operational — run the migrations, set one env var, deploy. See
**"What's left for you"** below.

## What FlowDesk actually turned out to be

Earlier drafts of this guide assumed things the codebase does not do. The code
now targets reality; keep these in mind before writing anything new:

| Assumed | Actual |
|---|---|
| An `organizations` table | `teams` + `team_members`; solo users have `team_id = NULL` |
| Supabase Auth (`auth.uid()`) | FlowDesk's own HS256 JWT; `auth.uid()` is NULL for app traffic |
| Auth sets `req.userId` / `req.orgId` | `authenticate` sets `req.user = { id, email, team_id, role }` |
| Routes mounted in `server.js` | `server.js` only listens; routes live in `src/app.js` |
| Vite frontend with entry points | No bundler, no build step — `frontend/*.html` is served as-is |
| `npm i openai` | FlowDesk calls OpenAI over `fetch`; no SDK is installed, so the brief does too |
| A reusable PDF renderer | `pdf.service.js` only knew how to draw invoices; a generic `renderHtmlToPdf` was split out of it |

**The org scope key.** `organization_id` = `user.team_id ?? user.id`, mirroring
FlowDesk's `src/utils/scopeOwner.js`. It therefore points at `teams.id` for
team accounts and `users.id` for solo ones, which is why it carries no foreign
key. One consequence worth knowing: if a solo user records real estate data and
*later* creates a team, their scope key changes and the old rows go quiet. The
same is already true of FlowDesk's own invoices and clients. Backfill when it
happens:

```sql
update re_projects set organization_id = '<team-id>' where organization_id = '<user-id>';
-- repeat for re_units, re_customers, re_sales_reps, re_reservations,
-- re_installment_plans, re_installment_schedule, re_payments,
-- re_documents, re_tasks, re_ai_briefs
```

## What's left for you

1. **Run the migrations** in the Supabase SQL editor, in order:
   `migrations/001_phase1_schema.sql`, then `migrations/002_ai_briefs.sql`.
   No find/replace needed — they already target `teams`/`public.users`. Both
   are idempotent, so re-running is safe.
2. **Set `OPENAI_API_KEY` on Railway** if it isn't already set. Optional: with
   no key the daily brief still runs and produces a rule-based summary and
   drafts, marked `generated_by: 'fallback'`.
3. **Deploy.** `node-cron` is already in `package.json`; Railway keeps the
   process alive, so the 07:00 Africa/Lagos job runs without extra infra.
4. **Run the smoke test** (below) against staging.

The Storage bucket needs no setup — `re-documents` is created privately on
first document generation.

## Where everything went

```
flowdesk-backend/
  src/re/                     ← the whole module (copied; see "Staying in sync")
    routes/  services/  middleware/  jobs/  templates/  utils/  test/
  frontend/realestate.{html,css,js}
```

Five hand-made edits in FlowDesk itself — the sync script never touches these:

| File | Edit |
|---|---|
| `src/app.js` | mounts `app.use('/api/re', authenticate, reRoutes)` after `express.json()`/`sanitizeBody`; requires `./re/jobs/daily`; **added `PATCH` to the CORS `methods` list** — it was missing, and every status transition in this module is a PATCH |
| `src/controllers/paystack.controller.js` | `charge.success` calls `handleRealEstateCharge()` first and breaks if it returns true |
| `src/services/pdf.service.js` | `renderHtmlToPdf(html)` split out and exported; `generateInvoicePdf` now calls it (no behaviour change) |
| `frontend/index.html` | hidden "Real Estate" nav item + `initRealEstateNav()`, revealed only when the workspace has ≥1 project |
| `package.json` | `node-cron`; `test:re` and `smoke:re` scripts |

**No second webhook endpoint exists.** Real estate references are namespaced
`REINST-<schedule-uuid>-<timestamp>`; the handler returns `false` for anything
else so subscription billing proceeds untouched, and it is idempotent against
Paystack's retries (checked reference plus a unique partial index).

## Staying in sync

This module is the canonical source; FlowDesk holds a copy.

```bash
node scripts/sync-to-flowdesk.js ../../flowdesk-backend          # apply
node scripts/sync-to-flowdesk.js ../../flowdesk-backend --check  # diff, exit 1 if stale
```

## Testing

```bash
# From the FlowDesk checkout (dependencies live there):
npm run test:re      # 23 logic tests, no network, no database

RE_SMOKE_TOKEN=<fd_token from localStorage> npm run smoke:re
```

`test:re` covers the things that must not silently break: schedules summing to
the exact plan total in kobo, month-end clamping (31 Jan → 28 Feb),
timezone independence, `REINST-` references round-tripping through a UUID,
HTML escaping in the allocation letter, and the rule-based brief.

`smoke:re` runs the acceptance sequence against a live server: project → 5
units → 2 customers → reservation with a 12-month plan (12 rows, unit flips to
`reserved`) → **second reservation on the same unit rejected with 409** →
payment settles installment 1 → brief generates → dashboard reflects it all.
It writes real rows named `Test Estate <timestamp>` — point it at staging.

## Deliberately NOT in v1 (do not add)

Buyer/Seller/Mortgage/Legal/Pricing/Market agents, agent orchestration, MLS,
multi-country, marketplace, voice, in-app WhatsApp sending. One AI worker
only: the daily brief plus drafted follow-ups. See `docs/AI_WORKFORCE.md` for
the growth path and the gates each future agent must clear.

## Design note

The real estate screen has its **own visual identity** and deliberately does
not inherit FlowDesk's design tokens — it is a separate product that happens
to share a login. It shares the session (`localStorage.fd_token`) and the API
base (`window.__API_BASE__`), and nothing visual.
