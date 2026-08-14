-- ============================================================
-- Buyer referral network — SECTION 5.
--
-- Every buyer gets a unique 8-character code the moment they are created
-- (src/services/referralService.js's generateReferralCode(), assigned in
-- POST /customers) so there is never a buyer without one to share. Existing
-- rows are backfilled below in the same migration, not by a separate script,
-- for the same reason 005's soft-delete columns were backfilled inline: an
-- application code path that assumes every row has a code must be true from
-- the moment this migration finishes, not from whenever a backfill job next
-- happens to run.
--
-- referred_by_customer_id is the durable "who gets credit" pointer, set once
-- at creation and never rewritten. re_customer_referrals alongside it is not
-- redundant — it is the one-row-per-referral WORKFLOW record (pending until
-- the referred buyer's first payment, then completed with whatever reward
-- was actually configured AT THAT MOMENT), which referred_by_customer_id
-- alone cannot represent: reward rules can change between when someone was
-- referred and when they convert, and a report ("total credits given") needs
-- the reward as it was actually paid, not as configured today.
--
-- referral_credit_balance is a running, informational balance — see
-- referralService.applyCreditToOutstandingBalance() for why a referral
-- reward reduces what a buyer owes by shrinking installment amount_due (and
-- the owning plan's total_amount by the same figure, preserving
-- installmentService's "schedule sums to the plan total in kobo" invariant)
-- rather than by inserting a fake re_payments row: this is not real
-- settled money, and a payment row means real money everywhere else in this
-- product — commission accrual, "total collected", the investor report.
-- Whatever a credit cannot immediately offset (nothing currently owed) sits
-- here until there is something to apply it to.
--
-- Safe to re-run.
-- ============================================================

alter table re_customers add column if not exists referral_code text;
alter table re_customers add column if not exists referred_by_customer_id uuid references re_customers(id) on delete set null;
alter table re_customers add column if not exists referral_credit_balance numeric(14,2) not null default 0;

-- Backfilled before the unique/not-null constraints are added below, so an
-- existing buyer is never caught mid-migration without a code. md5 of the
-- row's own id salted with a fresh random draw keeps a re-run's backfill
-- (which only ever touches rows still null) from ever producing the same
-- code twice in one batch.
update re_customers
  set referral_code = upper(substr(md5(id::text || clock_timestamp()::text || random()::text), 1, 8))
  where referral_code is null;

alter table re_customers alter column referral_code set not null;

-- A DB-level default (same convention as every id column's
-- `default gen_random_uuid()`) so a code exists no matter which path inserts
-- the row — the application never sets this column itself.
alter table re_customers alter column referral_code
  set default (upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 8)));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_customers_referral_code_unique') then
    alter table re_customers add constraint re_customers_referral_code_unique unique (referral_code);
  end if;
end $$;

create index if not exists idx_re_customers_referred_by on re_customers(referred_by_customer_id) where referred_by_customer_id is not null;

create table if not exists re_customer_referrals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  referring_customer_id uuid not null references re_customers(id) on delete cascade,
  -- One referral record per referred buyer — a buyer was brought in by
  -- exactly one other buyer, matching re_customers.referred_by_customer_id's
  -- own 1:1 shape.
  referred_customer_id uuid not null references re_customers(id) on delete cascade unique,
  status text not null default 'pending' check (status in ('pending', 'completed')),
  -- Snapshot of what Settings had configured AT COMPLETION, not a live join
  -- to re_org_settings — a report run after the reward rules change must
  -- still show what was actually paid out on old referrals.
  reward_type text check (reward_type in ('cash', 'credit')),
  reward_amount numeric(14,2),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_customer_referrals_org on re_customer_referrals(organization_id);
create index if not exists idx_re_customer_referrals_referring on re_customer_referrals(referring_customer_id);
create index if not exists idx_re_customer_referrals_status on re_customer_referrals(organization_id, status);

alter table re_customer_referrals enable row level security;
drop policy if exists "org members access re_customer_referrals" on re_customer_referrals;

-- The developer's own choice of reward, read at referral-completion time
-- (src/services/referralService.js) — 'none' is the default so a workspace
-- that never opens this settings panel keeps referrals tracked but unpaid,
-- never silently owing buyers money nobody configured.
alter table re_org_settings add column if not exists referral_reward_type text not null default 'none';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 're_org_settings_referral_reward_type_check') then
    alter table re_org_settings add constraint re_org_settings_referral_reward_type_check
      check (referral_reward_type in ('none', 'cash', 'credit'));
  end if;
end $$;
alter table re_org_settings add column if not exists referral_reward_amount numeric(14,2) not null default 0;

-- ── WhatsApp Business API (Meta Cloud API) — outbound send credentials ────
-- Pulled forward from SECTION 9 rather than duplicated there: this section's
-- own spec ("notify the referring buyer via email and WhatsApp") cannot be
-- satisfied without somewhere to send FROM, so the credential columns and
-- notificationService.sendWhatsApp() are built now, on the exact same
-- per-workspace-key-with-platform-fallback shape as Paystack/Resend/Termii
-- (migrations/017-019). SECTION 9 adds the INBOUND webhook and reuses this
-- same send path for agent replies rather than inventing a second one.
alter table re_org_settings add column if not exists whatsapp_token_encrypted text;
alter table re_org_settings add column if not exists whatsapp_token_last4     text;
alter table re_org_settings add column if not exists whatsapp_phone_number_id text;
alter table re_org_settings add column if not exists whatsapp_business_account_id text;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_customer_referrals to service_role;
  revoke all on public.re_customer_referrals from anon, authenticated;
end $$;
