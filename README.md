# Real Estate Sales Operations Module (Nigeria MVP)

Extends FlowDesk into off-plan/installment sales management for Nigerian real
estate developers. One AI worker: a Sales Operations Manager that produces a
daily brief, flags at-risk buyers, and drafts follow-ups.

**Status:** integrated into `flowdesk-backend`. Remaining steps are
operational — run the two migrations, set `OPENAI_API_KEY`, deploy. See
[CLAUDE.md](CLAUDE.md).

## What's inside

- `migrations/` — 2 idempotent SQL files, additive, targeting FlowDesk's real
  schema (`teams`/`public.users`), with deny-by-default RLS
- `src/routes/` — projects, units, customers, sales reps, reservations
  (atomic double-allocation guard), payments (Paystack + bank transfer/cash/
  POS), documents, tasks, dashboard KPIs, AI brief
- `src/services/` — kobo-precise installment schedules, Paystack (namespaced
  `REINST-*` references, idempotent webhook handler), overdue marking, the
  daily brief (OpenAI over `fetch`, with a rule-based fallback), allocation
  letter generation
- `src/jobs/daily.js` — 07:00 Africa/Lagos: mark overdue → brief each org
- `src/templates/allocation_letter.html` — A4 letter for Puppeteer
- `src/test/` — `logic.test.js` (23 tests, no network) and `smoke.js` (8-step
  live acceptance run)
- `frontend/` — the Sales Operations screen: brief, KPI ledger, at-risk list,
  copy-to-WhatsApp drafts, tasks
- `scripts/sync-to-flowdesk.js` — push this module into a FlowDesk checkout

## Design

The frontend has its **own visual identity** — a warm "morning dispatch"
almanac: paper stock, hairline rules, editorial serif for prose, tabular
monospace for money. It deliberately does not inherit FlowDesk's design
tokens. This is a separate product that shares a login, not a new tab in an
invoicing app. Colour always encodes state: clay for what's late, brass for
what the AI wrote, moss for money in.

## Reusing FlowDesk, not rebuilding it

Auth, teams, the Paystack account and its verified webhook, Puppeteer,
Supabase Storage and Resend all already existed and are used as-is. The module
adds one generic `renderHtmlToPdf` to FlowDesk's PDF service and otherwise
only mounts itself.

## Start here

Read [CLAUDE.md](CLAUDE.md) for integration state and what's left, then
`docs/` — [Vision](docs/VISION.md), [Architecture](docs/ARCHITECTURE.md),
[Database](docs/DATABASE.md), [API](docs/API.md), [PRD](docs/PRD.md),
[Tasks](docs/TASKS.md), [AI Workforce](docs/AI_WORKFORCE.md). The docs define
what v1 is and — just as important — what is deliberately deferred.
