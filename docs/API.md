# API Reference

Three mounts, three different ideas of who is calling:

| Prefix | Auth | Who |
|---|---|---|
| `/api/auth` | none | somebody who does not have a token yet |
| `/api/re` | HS256 bearer, `src/middleware/auth.js` | staff, scoped to `organization_id` (= `team_id ?? user_id`) |
| `/api/portal` | portal token (`aud: 're-portal'`) | a buyer holding a link |
| `/api/webhooks` | HMAC-SHA512 over the raw body | Paystack |

The staff token and the portal token are **not interchangeable in either
direction**. `middleware/auth.js` rejects a portal token; `verifyPortalToken`
rejects a staff one.

Successful handlers return plain JSON — an object or an array, no envelope.
Failures go through the global error handler and arrive as
`{ success: false, error }` with a meaningful status code: 400 for bad input,
401 for auth, 403 for a role that may not do this, 404 for a missing row in
your org, 409 for a conflict the business rules refuse (unit already reserved,
installment already paid).

`GET /health` is unauthenticated; it reports database reachability for the
platform's health checks.

---

## Auth — `/api/auth`

Rate-limited separately from everything else: 20 attempts per 15 minutes per
IP, successful logins not counted (a busy office behind one NAT would
otherwise lock itself out by working normally).

- `GET /config` — `{ google_client_id, allow_registration, min_password_length }`.
  What the sign-in screen needs before anyone types anything.
- `POST /register` — `{ email*, password*, full_name, company_name }` → `{ token, user }`
- `POST /login` — `{ email*, password* }` → `{ token, user }`.
  One message for a wrong password and an unknown address, and an unknown
  address burns the same time a real hash comparison would.
- `POST /google` — `{ credential* }` — the ID token from Google Identity
  Services, verified server-side against Google's published keys. Matched on
  `sub`, falling back to email so an account that signed up with a password can
  link. 503 when `GOOGLE_CLIENT_ID` is unset.
- `POST /forgot-password` — `{ email* }`. **Always** answers the same way.
  Outside production, and only when Resend is unconfigured, the response
  carries `dev_reset_url` so the flow is testable locally.
- `POST /reset-password` — `{ token*, password* }` → `{ token, user }`. Single
  use, time-boxed, and only the token's SHA-256 is ever stored.
- `GET /me` *(auth)* — profile plus `organization_id`, `is_team`, `role`, `has_password`
- `PATCH /me` *(auth)* — `{ full_name, company_name, password, current_password }`.
  Changing an existing password requires the current one; an account created
  through Google is *setting* one and has nothing to prove.

Passwords are scrypt verifiers — `scrypt$N$r$p$salt$key`, parameters stored
with the hash so the cost can be raised without invalidating old rows. Node's
`crypto`, so no native module and nothing to compile on the deploy host.

---

## Projects — `/api/re/projects`
- `GET /` — list + unit counts (total/sold/reserved/available)
- `POST /` — `{ name*, location, total_units, status }`
- `PATCH /:id` — partial; only supplied fields change

## Units — `/api/re/units`
- `GET /?project_id&status`
- `POST /` — `{ project_id*, unit_number*, list_price*, unit_type, size_sqm, metadata }` · 409 on duplicate unit number
- `POST /bulk` — `{ project_id*, units*: [...] }` · max 500, validated as a batch, reports the offending index
- `PATCH /:id` — price corrections, a floor plan added later. **Status is not
  settable here** — a unit's status follows its reservation, and letting it be
  set directly is how a sold unit gets marked available and sold twice.

`metadata` is free-form jsonb (floor plans, photos, brochure links) with two
rules: it must be an object, and any URL-shaped string inside it must be
`https://`. A `file:` or `data:` URL there ends up inside a Puppeteer-rendered
document.

## Customers — `/api/re/customers`
- `GET /?search` — matches name, phone or email
- `GET /:id` — full history: reservations → plans → schedules
- `POST /` — `{ full_name*, email, phone, source }`
- `PATCH /:id`
- `POST /:id/portal-link` — `{ send_email }` → `{ url, token, emailed, expires_in_days }`.
  A signed self-service link, sent by WhatsApp or email.
- `POST /:id/portal-revoke` — bumps `portal_token_version`, invalidating every
  link ever issued to that buyer. Links get forwarded; this is the undo.

## Sales reps — `/api/re/sales-reps`
- `GET /?include_inactive` — joined to the user profile
- `POST /` — `{ user_id*, commission_rate }` · falls back to the workspace default
- `PATCH /:id` — `{ active, commission_rate }` · deactivate rather than delete.
  A rate change affects **future accruals only**.

## Reservations — `/api/re/reservations`
- `GET /?status`
- `POST /` — `{ unit_id*, customer_id*, sales_rep_id, plan?: { total_amount, number_of_installments, frequency, start_date } }`
  → creates the reservation and the full schedule.
  **409 if the unit is not available.** The unit is claimed with a conditional
  UPDATE (`status='available'` in the WHERE clause), so two simultaneous
  requests cannot both win; a unique partial index backs it up. If the plan is
  invalid the whole thing unwinds — no orphan reservation, unit released.
- `PATCH /:id/status` — syncs unit status (cancel → available, complete → sold)

## Payments — `/api/re/payments`
- `GET /?limit&method&from&to` — most recent first (default 100, max 500)
- `GET /schedule?status&reservation_id&customer_id&due_before&limit` — the
  installment schedule itself, each row carrying `amount_paid` and
  `amount_outstanding`. Partial payment is normal here; a screen that cannot
  show it invites someone to record a ₦100k balance as a full installment.
- `POST /:scheduleId/init` — `{ customer_email* }` → Paystack link, charging only what is still **outstanding**
- `POST /:scheduleId/record` — `{ amount*, method, reference }` → the payment plus
  an `effects` object saying what actually happened: receipt generated,
  buyer emailed or not, commission accrued. The person who just took ₦2m
  should not have to guess.
- `POST /:id/receipt` — re-render. Idempotent (same row, same storage path), so
  it doubles as "the buyer lost it, send it again".
- `GET /:id/receipt` — fresh signed URL for an already-generated receipt

## Documents — `/api/re/documents`
- `GET /?status&doc_type&reservation_id`
- `POST /` — `{ reservation_id*, doc_type* }`
- `POST /:id/generate` — renders through Puppeteer, uploads to the private
  bucket, returns the row plus a signed `download_url`. Allocation letters and
  receipts render; other types 400.
- `GET /:id/download` — fresh 5-minute signed URL
- `PATCH /:id/status` — pending/generated/sent/signed

## Tasks — `/api/re/tasks`
- `GET /?status&source`
- `POST /` — `{ title*, notes, due_date, assigned_to, related_reservation_id }` · always `source: 'manual'`; only the brief writes `ai`
- `PATCH /:id/status` — open/done/dismissed

## Promises to pay — `/api/re/promises`
- `GET /?status&schedule_id&customer_id` — oldest promised date first
- `POST /` — `{ schedule_id*, promised_date*, promised_amount, spoke_to, notes }`.
  Supersedes any promise already open on that installment rather than stacking
  — the row that remains is always the buyer's latest word.
- `PATCH /:id/status` — kept/broken/cancelled, for what the sweep cannot see
  (paid in cash at the office, promise withdrawn on a second call)

The 07:00 job flips any promise whose date has passed with the installment
still unpaid to `broken`. That is a stronger signal than an overdue date,
because the buyer chose the date.

## Commissions — `/api/re/commissions`
- `GET /summary?from&to` — per rep: earned, owed, paid out, collected base
- `GET /?sales_rep_id&status&limit` — line by line, so a rep who disagrees with
  their total can be shown which payments it came from
- `PATCH /status` — `{ ids*: [...], status* }` · accrued → approved → paid
- `GET /performance` — reservations, portfolio value, collection rate, buyers
  at risk, commission earned. Every number already existed; it had simply never
  been on a page a sales director could open.

Accrual is **per payment**, not per reservation, because progressive commission
is how installment sales are actually paid. The rate is copied onto the row at
accrual time, and `unique (payment_id)` means a replayed webhook cannot pay a
rep twice.

## Search — `/api/re/search`
- `GET /?q=` — buyers, units, projects and reservations in one response,
  8 each. Below two characters it returns empty rather than everything.
  Phone matching also tries digits-only, so `0803 123` finds `+2348031234567`.

## Import — `/api/re/imports`
- `GET /template/:kind` — `customers` or `units`, as a downloadable CSV with an
  example row (a template with only headers gets filled in wrongly every time)
- `POST /units` — `{ project_id*, csv*, dry_run }`
- `POST /customers` — `{ csv*, project_id, dry_run }` — one row carries the
  buyer, their unit, their plan and how much they have already paid

`dry_run: true` returns exactly what would happen and writes nothing.
Imported payments settle the schedule and **do not** trigger receipts or
emails — sending 400 buyers a receipt for money they transferred last year is
not a welcome.

## Reports — `/api/re/reports`
- `GET /investor?project_id` — units, GDV, contracted, collected, receivables,
  collection rate, sell-through. Scoped to one project when asked, because an
  investor backed one development and has no business seeing the whole book.
- `GET /collections?months` — month-by-month collections (default 12, max 36)

## Settings — `/api/re/settings`
- `GET /` · `PUT /` — letterhead, default commission rate, notification
  preferences. `logo_url` must be `https://`.
- `GET /team` — members, or a one-row answer for a solo workspace
- `POST /team` — `{ name* }` — converts a solo workspace to a team **and moves
  every row**, because `organization_id` itself changes. Returns per-table
  counts so a partial move is visible. Sign out and back in afterwards.
- `POST /team/invite` — `{ email*, role }` · owner/admin only
- `PATCH /team/:id` — `{ role, status }` · the owner cannot be removed or demoted

## Audit — `/api/re/audit`
- `GET /?action&entity_type&entity_id&actor_id&from&to&limit`
- `GET /entity/:type/:id` — everything that ever happened to one record
- `GET /notifications?channel&status` — what was actually sent, including what
  was `skipped` because email is not configured

There is no route that writes, edits or deletes the log. A log the operator can
alter is not evidence.

## Dashboard & AI — `/api/re/dashboard`, `/api/re/brief`
- `GET /dashboard?project_id` — collected this month, outstanding, overdue
  `{count, amount}`, due-in-7-days, unit mix, open tasks `{total, from_ai}`,
  the project list, and the latest brief. One request for the whole screen.
  `project_id` scopes the money to one development.
- `GET /dashboard/at-risk?project_id` — customers with ≥2 overdue installments,
  with `days_late`, their escalation stage, and any promise they have made.
  **A broken promise sorts above a bigger number.**
- `GET /brief` · `GET /brief/history?limit` · `POST /brief/generate`

Briefs carry `generated_by`: `ai` when the model wrote them, `fallback` when a
rule-based summary was used (no `OPENAI_API_KEY`, a model error, or a quiet
day). The dashboard says which.

The brief reads escalation stage and promises, and writes to match: a warm
nudge at `reminder`, the Contract of Sale at `formal_notice`, allocation at
risk at `final_notice`, and **no drafted message at all** at `legal` — anything
written to a buyer whose file is with a lawyer can be read back in court.

---

## Buyer portal — `/api/portal`

Authenticated by a signed link, not an account: a buyer signs in twice a year
and a password is one more thing for them to forget. The token carries
`aud: 're-portal'` and the customer's `portal_token_version`, so bumping that
column revokes every link ever issued to them.

Every handler scopes to the customer **resolved from the token**. No handler
takes a customer id from the URL or the body — the moment one does, changing a
digit in a link shows you someone else's payment history.

- `GET /me` — balance, progress, next payment, every reservation and schedule,
  generated documents, payment history, and the developer's contact details
- `GET /documents/:id/download` — their own documents only; the download is audited
- `POST /pay/:scheduleId` — a Paystack link for their own installment, amount
  decided server-side from the schedule row

---

## Webhook — `/api/webhooks/paystack`

`POST`, unauthenticated in the bearer-token sense and verified by
HMAC-SHA512 of the **raw** request bytes against `PAYSTACK_SECRET_KEY`,
compared in constant time.

Mounted with `express.raw()` **before** `express.json()`. Parsing to an object
and re-serializing does not round-trip byte for byte — key order and
whitespace both move — and the signature is over bytes. Moving this mount
below the JSON parser silently breaks every incoming payment.

A verified event is acknowledged with 200 as soon as it is received; anything
that fails afterwards is logged rather than retried into a storm, because
Paystack retries any non-2xx for hours. An *unverified* request gets 401.

`handleRealEstateCharge(event)` returns `false` for references it does not own,
so this endpoint can be shared with another product on the same Paystack
account. References are `REINST-<schedule-uuid>-<timestamp>`; the schedule id
is itself a UUID containing `-`, so references are parsed by pattern, never by
splitting on the delimiter.

Both payment doors — this webhook and `POST /payments/:id/record` — end in
`paymentEvents.onPaymentRecorded()`, so a card payment and a bank transfer
produce the same receipt, the same commission and the same audit entry.
