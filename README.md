# Real Estate Sales Operations API (Nigeria MVP)

Off-plan and installment sales management for Nigerian property developers:
projects, units, buyers, reservations, installment schedules, payments,
allocation documents and tasks — plus one AI worker, a Sales Operations
Manager that writes a daily brief, flags at-risk buyers and drafts follow-ups.

A **standalone Node/Express service.** It owns its auth, its error handling
and its scheduled work.

## Run it

```bash
npm install
cp .env.example .env       # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET
npm start                  # → http://localhost:4000  ·  health at /health
```

Then run `migrations/001_phase1_schema.sql` and `migrations/002_ai_briefs.sql`
in the Supabase SQL editor. Both are idempotent.

**Entry point: `server.js`** at the repo root. There is no `src/app.js`.

## What's inside

- `server.js` — Express boot: helmet, CORS, rate limiting, JSON, auth, routes,
  health check, graceful shutdown, and the daily cron
- `src/routes/` — projects, units, customers, sales reps, reservations (atomic
  double-allocation guard), payments (Paystack + bank transfer/cash/POS),
  documents, tasks, dashboard KPIs, AI brief
- `src/services/` — kobo-precise installment schedules, Paystack (namespaced
  `REINST-*` references, idempotent webhook handler), overdue marking, the
  daily brief (OpenAI over `fetch`, with a rule-based fallback), allocation
  letter generation
- `src/middleware/` — HS256 bearer auth, org scoping, error handling
- `src/jobs/daily.js` — 07:00 Africa/Lagos: mark overdue → brief each org
- `src/test/` — `logic.test.js` (23 tests, offline) and `smoke.js` (live
  8-step acceptance run)
- `migrations/` — 2 idempotent SQL files with deny-by-default RLS
- `frontend/` — the Sales Operations screen
- `render.yaml` — Render blueprint

## Dependencies

| Package | Used for |
|---|---|
| `express`, `cors`, `helmet`, `express-rate-limit` | the HTTP layer |
| `jsonwebtoken` | verifying incoming bearer tokens |
| `@supabase/supabase-js` | the one service-role client |
| `node-cron` | the 07:00 Africa/Lagos brief job |
| `puppeteer` | rendering allocation letters to PDF |
| `dotenv` | local `.env` loading |

The daily brief needs no OpenAI SDK — it calls the API over `fetch`.

## Design

The frontend is a warm "morning dispatch" almanac: paper stock, hairline rules
instead of cards, editorial serif for prose, tabular monospace for money.
Colour always encodes state — clay for what's late, brass for what the AI
wrote, moss for money in. Light and dark themes both ship.

## Two rules the database enforces

Unique partial indexes, not just code paths, because a developer's reputation
depends on them: **one live reservation per unit** (no double allocation) and
**one payment per Paystack reference** (no webhook replay).

## Docs

[CLAUDE.md](CLAUDE.md) is the working guide — entry point, request pipeline,
deployment, and what degrades when a key is missing. Then `docs/`:
[Vision](docs/VISION.md), [Architecture](docs/ARCHITECTURE.md),
[Database](docs/DATABASE.md), [API](docs/API.md), [PRD](docs/PRD.md),
[Tasks](docs/TASKS.md), [AI Workforce](docs/AI_WORKFORCE.md). They define what
v1 is and — just as important — what is deliberately deferred.
