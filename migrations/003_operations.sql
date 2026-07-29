-- ============================================================
-- PHASE 2 SCHEMA — everything the operations product needs on
-- top of 001 (domain) and 002 (briefs).
--
-- Adds, in order:
--   A. Credentials       — this service now issues tokens too
--   B. Org settings      — letterhead + notification preferences
--   C. Commissions       — what each rep has earned, per payment
--   D. Promises to pay   — "I'll transfer on Friday", written down
--   E. Audit log         — who did what, when, from where
--   F. Notifications     — an outbox, so a silent product is visible
--   G. Escalation        — one missed payment ≠ five missed payments
--   H. Receipts + media  — documents attached to a payment, unit photos
--   I. Buyer portal      — token versioning for customer self-service
--
-- Safe to re-run. Every CREATE is IF NOT EXISTS, every column add
-- is ADD COLUMN IF NOT EXISTS, every constraint is added inside a
-- guard. Applying it twice changes nothing.
--
-- organization_id follows 001: teams.id for team accounts,
-- users.id for solo ones, hence no foreign key. RLS is enabled
-- with no policies for the reasons documented in 001.
-- ============================================================

-- ============================================================
-- SECTION A — CREDENTIALS
--
-- 001 said plainly: "there is no password column, because nothing
-- here logs anyone in." That is no longer true. This service now
-- owns login, so it stores a password VERIFIER — never a password.
--
-- The hash format is scrypt (Node's crypto, no native dependency):
--   scrypt$N$r$p$<salt-hex>$<key-hex>
-- The parameters travel with the hash, so raising the cost later
-- does not invalidate existing rows.
--
-- Rows created before this migration have password_hash NULL.
-- Those accounts cannot log in with a password — they either use
-- Google, or set one through the reset flow. That is deliberate:
-- a NULL hash must never be treated as "any password matches".
-- ============================================================

alter table users add column if not exists password_hash text;
alter table users add column if not exists google_sub text;
alter table users add column if not exists avatar_url text;
alter table users add column if not exists reset_token_hash text;
alter table users add column if not exists reset_token_expires_at timestamptz;
alter table users add column if not exists last_login_at timestamptz;

-- Google accounts are matched on `sub`, the only Google claim that is
-- stable and never reused. Email is not — people change theirs.
create unique index if not exists uniq_users_google_sub
  on users(google_sub) where google_sub is not null;

-- Logins are case-insensitive: nobody types the capital letter they
-- registered with. Guarded because an existing table may already hold
-- two rows differing only in case, and failing the whole migration over
-- that would be worse than leaving the plain unique constraint alone.
do $$
begin
  create unique index if not exists uniq_users_email_lower on users(lower(email));
exception when unique_violation then
  raise notice 'users.email has case-insensitive duplicates; skipping lower(email) index';
end $$;

-- Reset tokens are looked up by their hash, never by the token itself.
create index if not exists idx_users_reset_token on users(reset_token_hash)
  where reset_token_hash is not null;

-- ============================================================
-- SECTION B — ORG SETTINGS
--
-- 001 put letterhead on the user profile, which works for a solo
-- account and reads oddly for a team ("whose company name?").
-- This table is keyed by organization_id, so it answers the same
-- question for both shapes. documentService prefers it and falls
-- back to the user/team columns, so existing installs keep working.
-- ============================================================

create table if not exists re_org_settings (
  organization_id uuid primary key,
  company_name text,
  logo_url text,
  address text,
  phone text,
  website text,
  -- Default rate applied to a new sales rep, in percent.
  default_commission_rate numeric not null default 0
    check (default_commission_rate >= 0 and default_commission_rate <= 100),
  -- Where the "high severity risk" email goes. Usually the MD.
  notify_md_email text,
  notify_on_payment boolean not null default true,
  notify_on_overdue boolean not null default true,
  -- Automated SMS to BUYERS, three days before a due date and the morning
  -- after one is missed. Defaults to FALSE, unlike the other two, and that
  -- asymmetry is deliberate: the others notify the developer's own staff,
  -- while this one messages their customers and bills them per message. That
  -- is a decision an operator makes on purpose, not one they discover.
  notify_payment_reminders boolean not null default false,
  reply_to_email text,
  updated_at timestamptz not null default now()
);

alter table re_org_settings add column if not exists notify_payment_reminders boolean not null default false;

drop trigger if exists re_org_settings_set_updated_at on re_org_settings;
create trigger re_org_settings_set_updated_at
  before update on re_org_settings
  for each row execute function set_updated_at();

-- ============================================================
-- SECTION C — COMMISSIONS
--
-- Nigerian sales reps are paid a percentage of the sale, and on
-- installment sales they are usually paid PROGRESSIVELY — a slice
-- of each payment as it lands, not a lump sum at reservation.
-- So a commission row is created per payment, not per reservation.
--
-- The rate is COPIED onto the row at accrual time. Changing a rep's
-- rate must not silently rewrite what they already earned.
-- ============================================================

alter table re_sales_reps add column if not exists commission_rate numeric not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_sales_reps_commission_rate_check') then
    alter table re_sales_reps
      add constraint re_sales_reps_commission_rate_check
      check (commission_rate >= 0 and commission_rate <= 100);
  end if;
end $$;

create table if not exists re_commissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  sales_rep_id uuid not null references re_sales_reps(id) on delete cascade,
  reservation_id uuid not null references re_reservations(id) on delete cascade,
  payment_id uuid not null references re_payments(id) on delete cascade,
  -- Percent, copied from the rep at the moment the payment landed.
  rate numeric not null check (rate >= 0 and rate <= 100),
  base_amount numeric not null check (base_amount >= 0),
  amount numeric not null check (amount >= 0),
  status text not null default 'accrued' check (status in ('accrued','approved','paid','void')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  -- One accrual per payment. This is the idempotency lock: the payment
  -- path can be re-run (a webhook replay, a manual re-record) without
  -- paying a rep twice for the same money.
  unique (payment_id)
);

create index if not exists idx_re_commissions_org_rep on re_commissions(organization_id, sales_rep_id);
create index if not exists idx_re_commissions_org_status on re_commissions(organization_id, status);

-- ============================================================
-- SECTION D — PROMISES TO PAY
--
-- The rep calls an overdue buyer, the buyer says "Friday". Today
-- that lives in the rep's head or a WhatsApp thread and is forgotten
-- by Monday. A promise is a row with a date, so the morning sweep can
-- flip it to 'broken' and the brief can say so.
-- ============================================================

create table if not exists re_payment_promises (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  schedule_id uuid not null references re_installment_schedule(id) on delete cascade,
  customer_id uuid references re_customers(id) on delete set null,
  promised_date date not null,
  promised_amount numeric check (promised_amount is null or promised_amount > 0),
  -- Who at the buyer's end actually said it — often a spouse or a PA.
  spoke_to text,
  logged_by uuid references public.users(id) on delete set null,
  notes text,
  status text not null default 'open' check (status in ('open','kept','broken','cancelled')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_promises_org_status on re_payment_promises(organization_id, status, promised_date);
create index if not exists idx_re_promises_schedule on re_payment_promises(schedule_id);

-- Only one promise can be outstanding against an installment at a time.
-- A second call that produces a new date supersedes the first rather than
-- stacking, which is what "he keeps promising" actually means operationally.
create unique index if not exists uniq_re_open_promise_per_schedule
  on re_payment_promises(schedule_id) where status = 'open';

-- ============================================================
-- SECTION E — AUDIT LOG
--
-- Allocation and payment disputes in Nigerian property development
-- end up in front of lawyers. "Who recorded this ₦5m and when" has
-- to be answerable from the system, not from memory.
--
-- actor_id is NOT a foreign key: rows must survive the deletion of
-- the user who made them, or the log destroys its own evidence.
-- actor_email is denormalized for the same reason.
-- ============================================================

create table if not exists re_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  actor_id uuid,
  actor_email text,
  -- 'user' | 'system' | 'paystack' | 'ai' | 'portal'
  actor_kind text not null default 'user',
  action text not null,          -- 'payment.record', 'reservation.create', ...
  entity_type text not null,     -- 're_payments', 're_reservations', ...
  entity_id uuid,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_audit_org_created on re_audit_log(organization_id, created_at desc);
create index if not exists idx_re_audit_entity on re_audit_log(entity_type, entity_id);
create index if not exists idx_re_audit_actor on re_audit_log(organization_id, actor_id);

-- ============================================================
-- SECTION F — NOTIFICATIONS OUTBOX
--
-- Every send is written down whether it succeeded, failed or was
-- skipped for want of an API key. Without the row, "did the buyer get
-- their receipt?" has no answer, and a missing RESEND_API_KEY looks
-- identical to a delivered email.
-- ============================================================

create table if not exists re_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  channel text not null check (channel in ('email','sms')),
  recipient text not null,
  subject text,
  body text not null,
  template text,
  status text not null default 'sent' check (status in ('sent','failed','skipped')),
  provider text,
  provider_id text,
  error text,
  related_type text,
  related_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_notifications_org_created on re_notifications(organization_id, created_at desc);
create index if not exists idx_re_notifications_related on re_notifications(related_type, related_id);

-- ============================================================
-- SECTION G — ESCALATION
--
-- One missed payment is a reminder. Three is a formal letter. Five is
-- the legal team. The stage lives on the reservation because it is a
-- property of the relationship, not of a single installment.
-- ============================================================

alter table re_reservations add column if not exists escalation_stage text not null default 'none';
alter table re_reservations add column if not exists escalated_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_reservations_escalation_stage_check') then
    alter table re_reservations
      add constraint re_reservations_escalation_stage_check
      check (escalation_stage in ('none','reminder','formal_notice','final_notice','legal'));
  end if;
end $$;

-- ============================================================
-- SECTION H — RECEIPTS AND UNIT MEDIA
--
-- A receipt is a document attached to a payment. re_documents already
-- allows doc_type 'receipt'; it just had nothing to point at.
-- ============================================================

alter table re_documents add column if not exists payment_id uuid references re_payments(id) on delete cascade;

create unique index if not exists uniq_re_documents_receipt_per_payment
  on re_documents(payment_id) where payment_id is not null and doc_type = 'receipt';

-- Floor plans, site photos, brochure links. jsonb rather than columns
-- because what a developer wants to attach to a unit is not knowable
-- in advance, and every guess would be a migration.
alter table re_units add column if not exists metadata jsonb not null default '{}'::jsonb;

-- ============================================================
-- SECTION I — BUYER PORTAL
--
-- Buyers get a signed link rather than an account: a password is one
-- more thing for a buyer who signs in twice a year to forget.
-- Bumping portal_token_version invalidates every link previously
-- issued to that customer, which is the revoke button.
-- ============================================================

alter table re_customers add column if not exists portal_token_version integer not null default 0;
alter table re_customers add column if not exists portal_last_seen_at timestamptz;

-- Customer search hits name and phone constantly once a developer is
-- past ~40 buyers, which is exactly when the product stops being a demo.
create index if not exists idx_re_customers_org_name on re_customers(organization_id, full_name);
create index if not exists idx_re_customers_org_phone on re_customers(organization_id, phone);

-- ============================================================
-- Row Level Security — deny-by-default, as in 001 and 002
-- ============================================================
alter table re_org_settings enable row level security;
alter table re_commissions enable row level security;
alter table re_payment_promises enable row level security;
alter table re_audit_log enable row level security;
alter table re_notifications enable row level security;

-- ============================================================
-- Grants — see the Grants section of 001 for why this is not
-- redundant with RLS. Guarded so the file also runs on a plain
-- Postgres (src/test/schema.test.js).
-- ============================================================
do $$
declare t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  foreach t in array array[
    're_org_settings','re_commissions','re_payment_promises','re_audit_log','re_notifications'
  ] loop
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
