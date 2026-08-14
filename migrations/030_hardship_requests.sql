-- ============================================================
-- Payment pause / hardship mode — SECTION 4.
--
-- A formal, human-approved pause for a buyer who genuinely cannot pay for a
-- month or two. Two invariants are enforced HERE, not just in the route,
-- because "once per reservation" and "never automatic" are the two facts
-- the whole feature depends on and the database is the only place neither
-- can be bypassed by a bug in a later handler:
--
--   * uniq_re_hardship_one_approved_per_reservation — a reservation can have
--     at most one APPROVED request, ever. This is "once per reservation",
--     literally: once used, the button never reappears (routes/portal.js
--     checks this same fact before showing it, but the index is what makes
--     it true even if that check is ever removed or bypassed).
--   * uniq_re_hardship_one_pending_per_reservation — at most one PENDING
--     request at a time, so a buyer double-tapping "Submit" cannot queue two
--     requests for the same reservation.
--
-- There is no 'approved automatically' path anywhere in this schema or the
-- code that reads it — status starts 'pending' and only a PATCH from a
-- human (owner or sales_director — routes/hardshipRequests.js) ever moves it.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_hardship_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reservation_id uuid not null references re_reservations(id) on delete cascade,
  customer_id uuid not null references re_customers(id) on delete cascade,
  requested_by_portal boolean not null default true,
  reason text not null check (length(trim(reason)) >= 20),
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  pause_months integer not null check (pause_months between 1 and 3),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists uniq_re_hardship_one_approved_per_reservation
  on re_hardship_requests(reservation_id) where (status = 'approved');
create unique index if not exists uniq_re_hardship_one_pending_per_reservation
  on re_hardship_requests(reservation_id) where (status = 'pending');

create index if not exists idx_re_hardship_org_status on re_hardship_requests(organization_id, status);
create index if not exists idx_re_hardship_customer on re_hardship_requests(customer_id);

alter table re_hardship_requests enable row level security;
drop policy if exists "org members access re_hardship_requests" on re_hardship_requests;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_hardship_requests to service_role;
  revoke all on public.re_hardship_requests from anon, authenticated;
end $$;
