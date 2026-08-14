-- ============================================================
-- Buyer activity log — SECTION 2.
--
-- Free-text call/visit/WhatsApp/email notes a rep, collections officer or
-- director keeps against a buyer, independent of the payment schedule.
-- "Mrs Adeyemi called yesterday and said she will pay Monday" only exists
-- because it was written down somewhere — this is that somewhere, and the
-- morning brief (src/services/aiBrief.js) reads yesterday's rows back in.
--
-- WHO LOGGED IT is logged_by_user_id, not sales_rep_id. A literal
-- sales_rep_id column (re_sales_reps(id)) would reject every entry from
-- collections or a sales director, who log activities constantly (CLAUDE.md's
-- role model: "Collections... records payments, logs promises" — an activity
-- note is the same shape of fact) but have no re_sales_reps row at all,
-- since that table exists to price commission, not to name who works here.
-- users(id) is what every role has, the same column re_customers already
-- uses for "who did this regardless of job title"
-- (re_customers.created_by_user_id, migrations/016).
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null references re_customers(id) on delete cascade,
  logged_by_user_id uuid references users(id),
  activity_type text not null check (activity_type in ('call','visit','whatsapp','email','note','site_visit')),
  notes text not null check (length(trim(notes)) > 0),
  outcome text check (outcome in ('interested','not_interested','promised_payment','no_answer','follow_up_needed')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_re_activities_customer on re_activities(customer_id, created_at desc);
create index if not exists idx_re_activities_org_created on re_activities(organization_id, created_at desc);

alter table re_activities enable row level security;
drop policy if exists "org members access re_activities" on re_activities;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_activities to service_role;
  revoke all on public.re_activities from anon, authenticated;
end $$;
