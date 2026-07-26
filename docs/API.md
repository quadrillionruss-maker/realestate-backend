# API Reference

All routes under `/api/re`, all behind `src/middleware/auth.js` (HS256 bearer
token, algorithm pinned), all scoped to `organization_id`
(= `team_id ?? user_id`).

Successful handlers return plain JSON — an object or an array, no envelope.
Failures go through the global error handler and arrive as
`{ success: false, error }` with a meaningful status code: 400 for bad input,
401 for auth, 404 for a missing row in your org, 409 for a conflict the
business rules refuse (unit already reserved, installment already paid).

`GET /health` is the one unauthenticated route; it reports database
reachability for the platform's health checks.

## Projects
- `GET /projects` — list + unit counts (total/sold/reserved/available)
- `POST /projects` — { name*, location, total_units, status }
- `PATCH /projects/:id` — partial; only supplied fields change

## Units
- `GET /units?project_id&status`
- `POST /units` — { project_id*, unit_number*, list_price*, unit_type, size_sqm } · 409 on duplicate unit number
- `POST /units/bulk` — { project_id*, units*: [...] } · max 500, validated as a batch, reports the offending index

## Customers
- `GET /customers?search` — matches name, phone or email
- `GET /customers/:id` — full history: reservations → plans → schedules
- `POST /customers` — { full_name*, email, phone, source }
- `PATCH /customers/:id`

## Sales reps
- `GET /sales-reps?include_inactive` — joined to the FlowDesk user profile
- `POST /sales-reps` — { user_id* }
- `PATCH /sales-reps/:id` — { active } · deactivate rather than delete

## Reservations
- `GET /reservations?status`
- `POST /reservations` — { unit_id*, customer_id*, sales_rep_id, plan?: { total_amount, number_of_installments, frequency, start_date } }
  → creates the reservation and the full schedule.
  **409 if the unit is not available.** The unit is claimed with a conditional
  UPDATE (`status='available'` in the WHERE clause), so two simultaneous
  requests cannot both win; a unique partial index backs it up. If the plan is
  invalid the whole thing unwinds — no orphan reservation, unit released.
- `PATCH /reservations/:id/status` — syncs unit status (cancel → available, complete → sold)

## Payments
- `GET /payments?limit` — most recent first (default 100, max 500), with customer/unit context
- `POST /payments/:scheduleId/init` — { customer_email* } → Paystack link, charging only what is still **outstanding** on that installment
- `POST /payments/:scheduleId/record` — { amount*, method, reference } — bank_transfer/cash/pos; the installment flips to `paid` only once payments cover the amount due

## Documents
- `GET /documents?status&reservation_id`
- `POST /documents` — { reservation_id*, doc_type* }
- `POST /documents/:id/generate` — renders the allocation letter through
  FlowDesk's Puppeteer service, uploads to the private bucket, returns the row
  plus a signed `download_url`. 400 for doc types with no template yet (v1
  ships allocation letters only).
- `GET /documents/:id/download` — fresh 5-minute signed URL
- `PATCH /documents/:id/status` — pending/generated/sent/signed

## Tasks
- `GET /tasks?status&source`
- `POST /tasks` — { title*, notes, due_date, assigned_to, related_reservation_id } · always `source: 'manual'`; only the brief writes `ai`
- `PATCH /tasks/:id/status` — open/done/dismissed

## Dashboard & AI
- `GET /dashboard` — collected this month, outstanding, overdue {count, amount}, due-in-7-days, unit mix, open tasks {total, from_ai}, latest brief. One request for the whole screen.
- `GET /dashboard/at-risk` — customers with ≥2 overdue installments, with `days_late`, sorted by amount
- `GET /brief` — latest brief
- `GET /brief/history?limit` — recent briefs (default 14, max 90)
- `POST /brief/generate` — regenerate now; upserts on (org, date)

Briefs carry `generated_by`: `ai` when the model wrote them, `fallback` when a
rule-based summary was used (no `OPENAI_API_KEY`, a model error, or a quiet
day with nothing to report). The dashboard shows which.

## Webhook

`handleRealEstateCharge(event)` is exported from
`src/services/paystackService.js` and is idempotent against Paystack's
retries (it checks the reference, and a unique partial index makes the check
race-proof).

This service does **not** currently expose a webhook route. Payments recorded
through `POST /payments/:scheduleId/record` need none, and payment links are
reconciled when Paystack posts to whichever endpoint owns the account. To have
Paystack post here directly, add a route that verifies the
`x-paystack-signature` HMAC against the **raw** body — mounted before
`express.json()`, or the signature will not match — and call the handler from
its `charge.success` branch.

The handler returns `false` for references it does not own, so it can share a
webhook with another product on the same Paystack account without a second
endpoint. References are `REINST-<schedule-uuid>-<timestamp>`; the schedule id
is itself a UUID containing `-`, so references are parsed by pattern, never by
splitting on the delimiter.
