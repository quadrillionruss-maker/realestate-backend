# Database Reference

All tables prefixed `re_`, all carry `organization_id`. Additive to FlowDesk's
existing schema — nothing existing is altered.

## organization_id

`organization_id = user.team_id ?? user.id`, the same rule as FlowDesk's
`src/utils/scopeOwner.js`. It points at `teams.id` for team workspaces and
`users.id` for solo ones, so it carries **no foreign key**. It is denormalized
onto every table on purpose: one-line org filters and fast dashboard
aggregates without three-level joins. The Express layer sets it explicitly on
every insert (`src/middleware/orgContext.js`) — never inferred by trigger.

FlowDesk has no `organizations` table and no `org_members` table; earlier
drafts of this schema assumed both. Membership is `team_members`.

## Tables

| Table | Purpose | Key fields / rules |
|---|---|---|
| `re_projects` | A development (e.g. "Lekki Gardens Ph 2") | status: planning/active/sold_out/archived |
| `re_units` | Sellable units | unique (project, unit_number); status: available/reserved/sold |
| `re_customers` | Buyers | name, phone (WhatsApp), email, source |
| `re_sales_reps` | FlowDesk users tagged as reps | unique (org, user); FK → `public.users`; deactivated, never deleted |
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

That is deliberate, and stronger than it looks. FlowDesk issues its own HS256
JWT, so `auth.uid()` is NULL for all application traffic; a policy written
against it would silently evaluate to NULL and read as protection that does
not exist. Every query runs server-side through the service-role client (which
bypasses RLS by design), which is why each one filters `organization_id`
explicitly. No browser touches these tables directly.

If client-side Supabase access is ever added, a commented policy template
following FlowDesk's own `teams`/`team_members` shape sits at the bottom of
`migrations/001_phase1_schema.sql`.

## Storage

Allocation letters go to a **private** bucket (`re-documents`, created on
first use), not the public `logos` bucket — they carry a buyer's name and what
they paid. Rows persist the object path; `GET /documents/:id/download` mints a
5-minute signed URL on demand.
