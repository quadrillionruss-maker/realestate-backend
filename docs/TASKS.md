# Tasks

## Integration — done

- [x] Migrations rewritten for FlowDesk's real schema (`teams`/`public.users`,
      no `organizations`, no `org_members`), deny-by-default RLS, integrity
      indexes for double-allocation and webhook replay
- [x] `/api/re` mounted in `src/app.js` after `express.json()`/`sanitizeBody`,
      behind FlowDesk's `authenticate`
- [x] **`PATCH` added to the CORS `methods` allowlist** — it was missing and
      every status transition in this module is a PATCH
- [x] `orgContext` rewired to FlowDesk auth (`req.user.team_id ?? req.user.id`)
- [x] `handleRealEstateCharge` hooked into the existing Paystack webhook
- [x] `documents/:id/generate` wired to Puppeteer + private Storage bucket with
      signed URLs
- [x] `realestate.html/css/js` added as a static page (no Vite in this
      codebase); own visual identity; shares `fd_token`
- [x] Sidebar entry, revealed only for workspaces with ≥1 project
- [x] `node-cron` installed (`openai` not needed — the brief uses `fetch`)
- [x] 23 logic tests + an 8-step smoke script

## Operational — for you

- [ ] Run `migrations/001` then `002` in the Supabase SQL editor
- [ ] Set `OPENAI_API_KEY` on Railway (optional; without it the brief falls
      back to a rule-based summary)
- [ ] Deploy and run `npm run smoke:re` against staging

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
