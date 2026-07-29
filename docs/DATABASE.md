# Database Reference

`migrations/001_phase1_schema.sql` is **self-contained**: paste it into an
empty Supabase project and everything the API needs exists. It depends on no
pre-existing table, not even `auth.users`. It is also safe to run against a
database that already has an identity schema — every CREATE is
`IF NOT EXISTS` and every column add is `ADD COLUMN IF NOT EXISTS`, so
existing tables are topped up rather than fought over.

Run `001`, then `002`, then `003`. All three are idempotent; `npm run
test:schema` applies them twice against a real Postgres to prove it.

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
