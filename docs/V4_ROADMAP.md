# V4 — planned, not built

Captured 2026-09-16 as a specification for future work, at the user's request.
**Nothing in this document has been implemented.** No migration, route,
service, or frontend change described below exists yet — this is the intake
spec as given, kept here so the detail (table shapes, field names, route
paths, exact copy) survives until someone picks a section up.

Sections are independent of each other and, per the original instruction, are
meant to be built one at a time — full implementation, tests run, count
reported — rather than all at once. Nothing here is sequenced against the
others; build order is whoever picks this up's call.

## Before building anything here — read this first

This codebase has grown well past what `CLAUDE.md`'s own "as of this writing"
notes assume (migrations run past 090; `src/services/` already has ~70
files). Three of the ten sections below overlap with infrastructure that
**already exists**. Extend it — do not re-derive it:

- **Section 5 (bank reconciliation)** — `reconciliationService.js`
  (`migrations/091_reconciliation.sql`) already matches Archta's payment
  ledger against Paystack's transaction list and against a manually uploaded
  bank-statement CSV, by amount + date. The bank-specific CSV column parsers
  (GTBank/Access/Zenith/First Bank), the fuzzy-match tolerance (±₦1, ±3 days,
  buyer-name-in-narration), and the confidence-percentage/suggested-matches
  UI are genuinely new — the matching engine and the CSV upload path they'd
  plug into are not.
- **Section 6 (enterprise reporting) → Investor Report builder** —
  `investorReportService.js` already computes the investor/partner summary
  and is the single source both `routes/reports.js`'s `GET /investor` and
  `financeAgent.js`'s monthly PDF read from, specifically so the two can
  never drift apart. A new "Investor Report builder" needs to extend this
  service (multi-project selection, date range, letterhead/logo, metric
  picklist) rather than compute investor figures a second way. The Portfolio
  Overview tab and Board Report template are net-new.
- **Section 10.1 (anonymous peer benchmarking)** —
  `developerDnaService.getPeerBenchmark(orgId)` already implements this
  almost exactly as specced: `MIN_PEER_ORGS = 5`, an `eligible: false` /
  `peer_count` / `min_required` shape when there isn't enough data, computed
  from `re_developer_dna` (`migrations/077`), refreshed on the same Monday
  sweep `jobs/daily.js` already runs. What's missing is only the `GET
  /analytics/benchmarks` route surface and the Reports-screen card — the
  computation and the "insufficient data" gating are done. Check what
  metrics `re_developer_dna` already stores before adding new columns for
  ones it already has.

Two more are adjacent, not overlapping — worth reading before naming things,
so V4 doesn't introduce a second concept that looks like a first one:

- **Section 3 (onboarding emails)** is a *sent-mail sequence*.
  `onboardingService.js` (SECTION 23 in this codebase's own internal
  numbering — unrelated to "V4 Section 3" here) is a *setup checklist*
  computed live with no new table, shown on the dashboard and the admin
  Workspaces tab. Different feature, similar name — keep them named
  distinctly in code and UI so a future reader doesn't assume one supersedes
  the other.
- **Section 10.2 (cross-developer buyer reputation)** is adjacent to
  `referralService.js`'s existing `re_customers.referred_by_customer_id` /
  `re_customer_referrals` — that system links a buyer to the *specific
  person* who referred them inside one workspace's own book. Section 10.2 is
  a different, privacy-preserving cross-workspace signal (hashed phone, no
  identity crossing workspace boundaries) — it should not be built on top of
  the referral tables, but the two will sit next to each other in any buyer
  drawer UI and should be visually distinct.

`marketIntelAgent.js` (v2's per-workspace Market Intelligence Agent, reasoning
over one org's own locations/prices via an LLM with no live web access) is
**not** the same thing as Section 10.3's Market Intelligence Feed
(aggregated, anonymized, real numbers pooled across the network). Naming
these two anything similar in a shared UI will confuse "the AI's opinion
about your market" with "actual anonymized data from other developers" —
keep the copy unambiguous about which is which.

---

## SECTION 1 — Free trial system

Add a 14-day free trial to the signup flow.

- Migration: add to `re_organizations` —
  `trial_ends_at` (timestamptz, nullable), `is_trial` (boolean, default
  `true`), `trial_started_at` (timestamptz), `is_trial_expired` (boolean,
  default `false`).
- On organization creation: set `trial_started_at = now()`,
  `trial_ends_at = now() + interval '14 days'`, `is_trial = true`.
- Daily job step (`jobs/daily.js`): check for expired trials and lock them —
  `update re_organizations set is_trial_expired = true where trial_ends_at <
  now() and is_trial = true and is_trial_expired is not true`.
- `middleware/orgContext.js`, after loading the org: if `is_trial_expired` is
  true, return `402 Payment Required` with body
  `{ error: 'trial_expired', message: "Your 14-day trial has ended. Contact
  Archta to subscribe." }` on all routes **except** `GET /auth/me` and `GET
  /settings/workspace` (so the owner can still sign in and see basic
  workspace info).
- Frontend: a trial banner below the topbar when `is_trial` is true, showing
  days remaining (`trial_ends_at` minus today), a "Book a demo" button
  linking to `mailto:quadrillionruss@gmail.com`, and a dismiss button. When
  the trial is expired, show a full-screen paywall instead of the dashboard:
  centered card, Archta mark, "Your trial has ended." heading, "Book a demo"
  button, and the contact number `08039208319`. The owner can still reach
  Settings → Workspace to see their data; nothing else.
- Admin dashboard: Trial / Active / Expired status badge per workspace in the
  Workspaces tab.

## SECTION 2 — In-app knowledge base

Add a Help section to the sidebar under Management.

- New directory `frontend/help/` with one markdown article per topic:
  - `getting-started.md` — importing buyers, first brief, sending portal
    links
  - `buyers.md` — adding buyers, credit scores, default prediction,
    behavioral fingerprint
  - `payments.md` — recording payments, Paystack, bank transfer, receipts,
    reconciliation
  - `documents.md` — generating allocation letters, deeds, e-signature, bulk
    generation
  - `portal.md` — what buyers see, sending portal links, community forum
  - `agents.md` — how the 5 agents work, Deal Manager, WhatsApp bot,
    configuring agents
  - `reports.md` — collections trend, VAT report, payment heatmap, rep
    leaderboard, AI assistant
  - `settings.md` — workspace settings, team roles, Paystack setup, WhatsApp
    setup, VAT configuration
- New Help screen in `screens.js`: sidebar nav with the article list on the
  left, article content rendered as HTML on the right — markdown converted
  to HTML client-side with a simple regex-based renderer (no external
  library needed for basic markdown).
- A search bar that filters articles by keyword across all content.
- A floating "?" button, fixed bottom-left, on every screen — must not
  overlap the AI chat bubble — that opens the help drawer to the most
  relevant article for the current screen (a screen-name → article map).

## SECTION 3 — Onboarding email sequence

Automated onboarding emails for new workspaces. See the "adjacent, not
overlapping" note above re: `onboardingService.js` before naming this.

- New table `re_onboarding_emails`: `id`, `organization_id`, `email_type`
  (`welcome` / `brief_check` / `portal_check` / `collections_check` /
  `trial_ending` / `trial_expired`), `sent_at`, `created_at`.
- Daily job step checking which onboarding emails are due:
  - **Day 0** (on signup) — welcome email with import guide and getting
    started link.
  - **Day 1** — "did your brief arrive?" — asks if they saw the morning
    brief, links to the app.
  - **Day 3** — "have you sent portal links?" — about the buyer portal
    feature.
  - **Day 7** — "how are collections going?" — tips on the at-risk screen.
  - **Day 12** — trial-ending-in-2-days warning, if still on trial.
  - **Day 14** — trial-expired email with "book a demo" CTA.
- Check `re_onboarding_emails` first to avoid duplicate sends.
- Send via Resend through the existing `notificationService` email
  infrastructure.
- Branding: dark navy header with gold ◆ mark, clean white body, gold CTA
  button. From `quadrillionruss@gmail.com` (update to `sayyid@archta.io` once
  the domain is purchased).

## SECTION 4 — Public API + webhooks

A public API layer for developers to connect Archta to their own tools.

- New table `re_api_keys`: `id`, `organization_id`, `name`, `key_hash` (sha256
  of the actual key), `key_prefix` (first 8 chars, for display), `scopes`
  (jsonb array: `read:buyers` / `read:payments` / `read:projects` /
  `read:reservations` / `read:documents` / `webhooks`), `last_used_at`,
  `expires_at` (nullable), `created_at`.
- Routes: `POST /api-keys` (owner only — generates a key, returns it once,
  never stored in plain text), `GET /api-keys` (list, prefix + scopes only,
  never the full key), `DELETE /api-keys/:id` (revoke).
- API key auth middleware: requests to `/public/v1/` carrying `Authorization:
  Bearer archta_live_XXXX` are authenticated by `key_hash` lookup and scoped
  by the key's `scopes`.
- Public read-only endpoints under `/public/v1/`: `GET /public/v1/buyers`,
  `GET /public/v1/payments`, `GET /public/v1/projects` (with units), `GET
  /public/v1/reservations`. All paginated, filtered by the org the key
  belongs to, rate-limited to 1000 requests/hour/key.
- Webhooks: new table `re_webhooks`: `id`, `organization_id`, `url`, `events`
  (jsonb array: `payment.created` / `buyer.created` / `reservation.created` /
  `document.signed` / `installment.overdue`), `secret` (encrypted), `active`
  (boolean), `created_at`. On payment creation, POST to every active webhook
  URL with event type, timestamp, and payload; sign with HMAC-SHA256 using
  the webhook's secret in an `X-Archta-Signature` header.
- Settings → API section (owner only, Scale and Enterprise plans): API key
  management and webhook configuration.

## SECTION 5 — Bank reconciliation improvements

Extends `reconciliationService.js` (see overlap note above) with
Nigerian-bank-specific support — do not build a second matching engine.

- `bank_format` selector (`gtbank` / `access` / `zenith` / `firstbank` /
  `generic`) on the manual reconciliation CSV upload.
- Format-specific parsers, one per bank's own column names/date/amount
  formatting:
  - **GTBank**: `Date, Description, Debit, Credit, Balance` — `Credit` is
    inflow.
  - **Access**: `Trans.Date, Description, Debit, Credit, Balance` — same
    pattern.
  - **Zenith**: `Date, Remarks, Withdrawals, Deposits, Balance`.
  - **First Bank**: `Date, Narration, Withdrawals, Deposits, Balance`.
- Fuzzy matching improvements: amount within ±₦1 (kobo rounding), date within
  ±3 days (bank processing delays), buyer-name fragment in the narration
  (many buyers put their own name in the transfer narration).
- Show a match-confidence percentage per item.
- A "Suggested matches" section for near-misses — owner manually confirms or
  rejects each one.

## SECTION 6 — Enterprise reporting

Portfolio-level reporting for developers running multiple projects at once.
See the overlap note above re: `investorReportService.js` before building
the Investor Report builder.

- New Portfolio Overview tab on the Reports screen: total contracted value
  across all projects, total collected across all projects, collection rate
  per project as a comparison bar chart, at-risk concentration (which
  project carries the highest overdue exposure), rep performance across
  projects (a leaderboard spanning all projects, not one), monthly
  collection trend per project as a sparkline table (project name, then Jan,
  Feb, Mar… columns in ₦).
- Investor Report builder: owner selects which projects to include, a date
  range, and which metrics (contracted value, collected, outstanding,
  default rate, construction progress); generates a PDF with Archta
  letterhead plus the developer's own uploaded logo/branding if present.
  Build this as an extension of `investorReportService.js`.
- Board Report template: one-page executive summary — portfolio health
  score, top 3 risks, top 3 opportunities, recommended actions — generated
  by the AI assistant from real portfolio data.

## SECTION 7 — Multi-currency collection (not just display)

Upgrades the existing multi-currency *display* to actual multi-currency
*collection* for diaspora buyers.

- Migration: `re_payments` gets `currency` (varchar, default `NGN`),
  `fx_rate_at_payment` (decimal, nullable), `original_currency_amount`
  (decimal, nullable).
- Migration: `re_reservations` gets `allow_foreign_currency` (boolean,
  default `false`) and `accepted_currencies` (jsonb array, default `[NGN]`).
- Buyer portal: when a reservation allows foreign currency, show a currency
  selector. On selecting USD or GBP, fetch the current rate from
  ExchangeRate-API (already integrated for display), compute the equivalent
  amount, and generate a Paystack payment link in that currency (Paystack
  supports USD and GBP payment links).
- On payment confirmation, record the naira amount, the original foreign
  currency amount, and the fx rate used.
- Payments history: show foreign-currency payments clearly, with the
  original amount and rate alongside the naira figure.
- Reports: a Diaspora Payments section — total collected per currency, with
  naira equivalent.

## SECTION 8 — Customer support infrastructure

An in-app support ticket system so developers don't have to reach Archta
over WhatsApp.

- New table `re_support_tickets`: `id`, `organization_id`, `user_id`,
  `subject`, `description`, `status` (`open` / `in_progress` / `resolved` /
  `closed`), `priority` (`low` / `medium` / `high` / `urgent`), `category`
  (`bug` / `feature_request` / `billing` / `account` / `other`),
  `assigned_to` (nullable — an Archta team member's email), `created_at`,
  `updated_at`.
- New table `re_support_messages`: `id`, `ticket_id`, `sender_type`
  (`customer` / `support`), `sender_name`, `message`, `created_at`.
- Routes: `GET /support/tickets`, `POST /support/tickets`, `GET
  /support/tickets/:id`, `POST /support/tickets/:id/message`.
- Frontend: a Support section in Settings — ticket list with status badges,
  a "New ticket" form (subject/description/category), a ticket detail view
  with the message thread.
- Admin dashboard: a Support tab listing all open tickets across every
  workspace, filterable by priority and status; admin can reply, change
  status, and assign priority.
- On new ticket: email `quadrillionruss@gmail.com` with subject and
  description. On admin reply: email the developer with the reply.

## SECTION 9 — Advanced buyer intelligence

Three additions to the existing behavioral fingerprint.

1. **Payment prediction** — for any buyer with 3+ payments, compute a
   predicted next payment date from their payment pattern. Store as
   `re_customers.predicted_next_payment_date`. Show in the buyer drawer as
   "Likely to pay: [date]" in green. In the morning brief, buyers
   approaching their predicted date are flagged "Likely to pay soon" rather
   than "at-risk."
2. **Buyer lifetime value** — compute and store
   `re_reservations.buyer_lifetime_value`: total amount contracted across
   every reservation this buyer has in this workspace. Show in the buyer
   drawer. Feed it into the AI assistant's context so it can answer "Which
   buyers represent our highest lifetime value?"
3. **Cohort analysis** — a Cohort tab on Reports: buyers grouped by
   reservation month. Per cohort: how many buyers started, how many are
   still paying on schedule, how many defaulted, average collection rate at
   3/6/12 months. The intent is to show which sales periods (channel,
   season, rep) produced the most reliable buyers.

## SECTION 10 — Platform network effects

Features that get more valuable as more developers use Archta. See the
overlap notes above — 10.1 already has a computation engine
(`developerDnaService.getPeerBenchmark`); 10.2 is adjacent to
`referralService.js` but must not reuse its tables.

1. **Anonymous peer benchmarking** — `GET /analytics/benchmarks`: anonymized
   cross-workspace metrics — average collection rate across workspaces in
   the same city, average days-to-payment after a reminder, average
   promise-kept rate, average credit-score distribution. Only returned when
   5+ workspaces have sufficient data; otherwise an `insufficient_data`
   flag. Reports screen gets a Benchmarks card: "Your collection rate: 67%.
   Similar developers in Abuja: 74%. Your promise kept rate: 58%. Network
   average: 63%." — shown only when data is sufficient, and never showing
   any individual workspace's numbers.
2. **Cross-developer buyer reputation** — when a buyer is added to a new
   workspace, check (by hashed phone number — never expose which workspace)
   whether they exist in any other workspace. If found, show a small
   indicator: "This buyer has activity on another Archta workspace" — no
   details, just the signal. Owner can request a shared reputation score
   (0–100, based on payment behavior across all workspaces, anonymized) with
   one click. New table `re_buyer_reputation`: `phone_hash` (sha256 of the
   normalized phone), `reputation_score` (integer), `workspaces_count`
   (integer — never exposed individually), `last_updated`. Recomputed
   nightly.
3. **Market intelligence feed** — a Market tab on Reports: anonymized
   market data across the network — average unit prices by location
   (Guzape, Maitama, Lekki, VI, etc.), average installment plan durations,
   most common default patterns by city, collection-rate trends across the
   market. Shown only when the network has sufficient data.

---

## Process, as instructed

Build one section at a time, completely, before moving to the next. Run the
full test suite after each section and report the count before proceeding.
After all ten, run the full suite once more and report the final count, plus
any deviations from this spec and the reasoning for each.
