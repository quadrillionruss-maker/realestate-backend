# Database Reference

`migrations/001_phase1_schema.sql` is **self-contained**: paste it into an
empty Supabase project and everything the API needs exists. It depends on no
pre-existing table, not even `auth.users`. It is also safe to run against a
database that already has an identity schema — every CREATE is
`IF NOT EXISTS` and every column add is `ADD COLUMN IF NOT EXISTS`, so
existing tables are topped up rather than fought over.

Run `001` through `005` in order. All five are idempotent; `npm run test:schema`
applies them twice against a real Postgres to prove it.

## Identity tables

Created by Section A of `001`, extended by Section A of `003`.

`001` said plainly that there is no password column, because nothing here
logged anyone in. **That is no longer true.** `003` adds `password_hash`,
`google_sub`, `reset_token_hash`, `reset_token_expires_at`, `avatar_url` and
`last_login_at`, because this service now issues tokens as well as verifying
them.

What is stored is a password **verifier**, never a password:

```
scrypt$16384$8$1$<salt-hex>$<key-hex>
```

The cost parameters travel with the hash, so raising them later leaves
existing rows verifiable. scrypt rather than bcrypt because bcrypt means a
native module, which means a compiler on the deploy host and a class of build
failure that has nothing to do with this product.

**A NULL `password_hash` is not "no password required".** It is a Google-only
account, or one created before `003`. `verifyPassword` returns false for it
unconditionally; the only ways in are Google or the reset flow.

`uniq_users_email_lower` makes sign-in case-insensitive, because nobody types
the capital letter they registered with. It is created inside an exception
guard: an existing table may already hold two rows differing only in case, and
failing the whole migration over that would be worse than leaving the plain
unique constraint alone.

| Table | Purpose | Read by |
|---|---|---|
| `users` | The person a token refers to, plus letterhead branding | `documentService.resolveBranding()`; FK target for `re_sales_reps.user_id` and `re_tasks.assigned_to` |
| `teams` | A shared workspace | `documentService.resolveBranding()` for the team branch |
| `team_members` | Membership; only `status='active'` counts | `middleware/auth.js`, to decide team vs solo scope |

`users.id` is a plain UUID with **no foreign key to `auth.users`**. If you sign
in with Supabase Auth, insert rows whose `id` matches the `auth.users` id — the
auth middleware accepts both the `sub` claim (what Supabase issues) and `id`.
If an external service owns login, use whatever id it puts in the token.
Neither is required, and the whole identity section can be dropped if you move
identity elsewhere: Section B references only `users(id)`.

A fresh install has no users, and every endpoint needs a token belonging to
one. The bootstrap block at the end of `001` shows the insert; `npm run token`
mints a matching token.

## Domain tables

All prefixed `re_`, all carrying `organization_id`.

## organization_id

`organization_id = user.team_id ?? user.id`. It points at a team for team
workspaces and at the user for solo ones, so it carries **no foreign key**. It
is denormalized onto every table on purpose: one-line org filters and fast
dashboard aggregates without three-level joins. The Express layer sets it
explicitly on every insert (`src/middleware/orgContext.js`) — never inferred
by trigger.

Team membership is read from `team_members` during authentication. If that
table is absent, every caller is treated as a solo account and scoped by user
id — so the service still runs against a database holding only the `re_*`
tables, should you strip Section A out.

One consequence worth knowing: if a solo user records data and *later* joins a
team, their scope key changes and the earlier rows go quiet. Backfill with
`update re_projects set organization_id = '<team-id>' where organization_id =
'<user-id>'`, repeated for each `re_*` table.

## Tables

| Table | Purpose | Key fields / rules |
|---|---|---|
| `re_projects` | A development (e.g. "Lekki Gardens Ph 2") | status: planning/active/sold_out/archived |
| `re_units` | Sellable units | unique (project, unit_number); status: available/reserved/sold |
| `re_customers` | Buyers | name, phone (WhatsApp), email, source |
| `re_sales_reps` | Users tagged as reps | unique (org, user); FK → `public.users`; deactivated, never deleted |
| `re_reservations` | Unit + customer + rep | status: reserved/confirmed/cancelled/completed; cancelling frees the unit |
| `re_installment_plans` | Plan attached to a reservation | total, count (1–120), frequency (monthly/quarterly), start_date |
| `re_installment_schedule` | Individual dues | unique (plan, number); status: pending/paid/overdue/waived; kobo-precise generation |
| `re_payments` | Money received | method: paystack/bank_transfer/cash/pos; partial payments sum toward `paid` |
| `re_documents` | Allocation letter, deed, receipts | status: pending/generated/sent/signed; `storage_path` → private bucket |
| `re_tasks` | Follow-ups | source: manual/**ai** — the brief writes here |
| `re_ai_briefs` | Daily brief history | unique (org, date); `payload` jsonb; `generated_by`: ai/fallback |

## The two integrity locks

These are not ordinary indexes — they are business rules the application
cannot be trusted to enforce alone:

```sql
-- One live reservation per unit, enforced by Postgres. The API also claims
-- units with a conditional UPDATE; this is the backstop against a race.
create unique index uniq_re_active_reservation_per_unit
  on re_reservations(unit_id) where status in ('reserved','confirmed');

-- Paystack retries deliveries. A replayed charge.success must not insert a
-- second payment row.
create unique index uniq_re_payments_paystack_reference
  on re_payments(paystack_reference)
  where paystack_reference is not null and method = 'paystack';
```

## Indexes

Cover: projects/customers by org, units by project and by (org, status),
reservations by unit, customer and (org, status), schedule by plan, by
(status, due_date) and (org, status, due_date), payments by schedule and
(org, paid_at desc), documents by (org, status), tasks by (org, status),
briefs by (org, brief_date desc).

## Row Level Security — deny-by-default

RLS is **enabled on every table with no policies at all**, which means the
anon and authenticated keys can read nothing.

That is deliberate, and stronger than it looks. Callers authenticate with an
HS256 bearer token rather than a Supabase Auth session, so `auth.uid()` is
NULL for all application traffic; a policy written against it would silently
evaluate to NULL and read as protection that does not exist. Every query runs
server-side through the service-role client (which bypasses RLS by design),
which is why each one filters `organization_id` explicitly. No browser touches
these tables directly.

If client-side Supabase access is ever added, a commented policy template
following the `teams`/`team_members` shape sits at the bottom of
`migrations/001_phase1_schema.sql`.

## Grants

RLS and privileges are two separate gates, and `service_role`'s BYPASSRLS only
opens the first. It still needs ordinary table privileges, and **not every
Supabase project grants them by default**. Without them the API authenticates
fine and then fails every query with:

```
42501: permission denied for table re_projects
```

The Grants block at the end of `001` fixes this, and re-running the migration
is the fix — it is idempotent, so on an existing database it changes nothing
except the privileges. `anon` and `authenticated` are revoked explicitly, so
deny-by-default holds at the privilege layer too and not only through RLS. If
you later add client-side policies, you must re-grant to those roles; policies
alone will not be enough.

## Storage

Allocation letters and receipts go to a **private** bucket (`re-documents`,
created on first use) — they carry a buyer's name and what they paid. Rows
persist the object path, never a bearer link; `GET /documents/:id/download`
mints a 5-minute signed URL on demand. Receipts land under
`<org>/receipts/<document-id>.pdf` in the same bucket under the same rules,
because a receipt that is more public than an allocation letter is a bug
nobody would notice.

## What `003` adds

| Table | Purpose | Written by |
|---|---|---|
| `re_org_settings` | Letterhead and notification preferences, keyed by `organization_id` — so it answers the same way for a solo account and a team | `routes/settings.js` |
| `re_commissions` | One accrual per payment, with the rate copied onto the row | `commissionService.accrueForPayment()` |
| `re_payment_promises` | "I'll transfer on Friday", with a date the sweep can check | `promiseService` |
| `re_audit_log` | Who did what, when, from where | `auditService` |
| `re_notifications` | Every send attempt, including the ones skipped for want of an API key | `notificationService` |

Plus columns: `re_sales_reps.commission_rate`,
`re_reservations.escalation_stage`, `re_units.metadata`,
`re_documents.payment_id`, `re_customers.portal_token_version`.

### The three new locks

```sql
unique (payment_id) on re_commissions
uniq_re_open_promise_per_schedule    -- partial: where status = 'open'
uniq_re_documents_receipt_per_payment -- partial: where doc_type = 'receipt'
```

Each exists because the application must not be the only thing preventing it:
paying a rep twice for one payment, a stack of promises instead of the buyer's
latest word, and two receipts for one ₦5m transfer.

### `re_audit_log` has no foreign keys, on purpose

`actor_id` is a bare UUID and `actor_email` is denormalized alongside it. An
audit row has to survive the deletion of the user who made it — a log that
cascades away when somebody leaves the company destroys its own evidence.
`npm run test:schema` asserts the table has zero foreign-key constraints, so
this cannot be "tidied up" by accident.

Nothing in the service updates or deletes from this table, and no route
exposes a way to. Append-only is the point.

### Escalation

`re_reservations.escalation_stage` is one of `none`, `reminder`,
`formal_notice`, `final_notice`, `legal`. It lives on the reservation rather
than the installment because it describes the relationship, not a single
missed date. The 07:00 sweep only ever raises it; the only thing that lowers
it is money (`paymentEvents.maybeDeescalate`).

## What `004` adds

Three things review found that the schema has to carry, because the application
cannot enforce them alone.

### `users.token_version` — revoking a live session

A JWT is valid until it expires, and ours last 30 days. A sales executive fired
on Monday therefore keeps a working token until the end of the month: the buyer
list, payment histories, allocation letters, from any machine. Changing their
password does not help — tokens already issued keep working.

`token_version` rides in the token as `tv` and is compared on every request.
Bumping the column invalidates every token ever issued to that user at once. It
is deliberately the cheap design: a denylist would need a store of live tokens
and an eviction policy, a counter needs neither.

Defaults to `0`, and a token minted before this migration carries no `tv` claim
which `middleware/auth.js` reads as `0` — so applying `004` does not sign
everybody out on deploy.

### One allocation letter per reservation

`uniq_re_allocation_letter_per_reservation`. Nothing stopped generating five,
each with its own reference number, and in a dispute three documents that
disagree are worse than none. Re-generating is still allowed and still
desirable — it rewrites the same row and the same storage path. A second *row*
is what is forbidden.

Created inside an exception guard: a database that already holds duplicates
would otherwise fail the migration and leave the other two sections unapplied.
The notice names the query that finds them.

### `re_payments.overpayment`

A buyer sends ₦5m against a ₦500k installment. The payment is recorded —
refusing it would leave money in the bank with nothing in the system to explain
it — but the excess used to pass in silence, and an unexplained credit is one of
the reliable triggers of a payment dispute here.

The column is on the payment, not the schedule: it describes that one transfer,
and the same installment can be overpaid more than once. It is a record, not an
instruction — nothing moves a credit automatically, because which installment it
belongs to is a conversation with the buyer.
`idx_re_payments_overpaid` makes "show me every unallocated credit" one cheap
query, which is the only way anybody actually runs it.


## What `005` adds

### `deleted_at` on every domain table

Nothing in this product is hard-deleted. A delete stamps `deleted_at`, cascades
to children, and leaves every row in place permanently — because a developer who
removes a buyer who has paid ₦15m over eighteen months must not be one click away
from losing that, and "we deleted it" is not an answer anyone wants to give a
lawyer.

The live filter is applied in `middleware/orgContext.js`, not per query. See
CLAUDE.md for why, and for the one thing it does not cover (embedded resources).

`re_audit_log` and `re_notifications` deliberately have **no** `deleted_at`. A
nullable column there would imply the evidence can be withdrawn.

### Every uniqueness lock, rebuilt

This is the part to read before touching `005`. Each index from `001`/`003`/`004`
was written before soft delete existed and would have counted a deleted row as
live. Concretely, without the `deleted_at is null` predicate:

* a soft-deleted reservation would block its unit **forever** — the unit could
  never be sold to anyone again
* a soft-deleted allocation letter would make a replacement impossible
* a soft-deleted receipt would block re-issuing one
* a soft-deleted promise would block logging the next one
* a soft-deleted unit would reserve its own unit number permanently

`re_commissions.payment_id` and `re_units(project_id, unit_number)` were table
constraints rather than indexes, so both are converted to partial unique indexes
to carry the predicate.

`npm run test:schema` asserts both directions of the important one: double
allocation is still refused, **and** a soft-deleted reservation releases the unit.

### Email verification

`email_verified_at`, `verify_token_hash`, `verify_token_expires_at`. Only the
token's SHA-256 is stored, exactly as with password resets.

Existing accounts are **backfilled as verified** — they registered before the
requirement existed, and locking them out on deploy would be a self-inflicted
outage. The backfill is idempotent, so re-running `005` tops up any account
created in between.

### Plan lifecycle

`status` (`active` | `superseded`), `superseded_by`, `restructured_at`,
`restructure_reason`, `original_total_amount`, `carried_amount_paid`.

A restructure creates a new plan rather than editing the old one, because the old
schedule is what the buyer's existing receipts refer to. The new plan's
`total_amount` is the remaining **balance** — `installmentService` guarantees the
schedule sums to the plan total to the kobo, and that invariant is worth more than
keeping the contract value in one field. So:

```
original_total_amount = carried_amount_paid + total_amount
```

`uniq_re_active_plan_per_reservation` allows exactly one active plan per
reservation. Two would mean two schedules and a dashboard counting the same debt
twice.
