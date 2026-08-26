-- ============================================================
-- Admin dashboard aggregation RPCs — AUDIT FIXES (Performance #1, #2, #3).
--
-- Three functions in adminService.js were pulling entire platform-wide
-- tables into Node just to compute a count/sum per workspace or per
-- channel — re_ai_briefs (a new row per org every single day, forever),
-- every non-voided payment's amount, and the entire re_notifications
-- table (retained forever, per CLAUDE.md's "Data retention" section).
-- Every one of these functions computes the same aggregation in Postgres
-- instead, returning one small row per group rather than the whole table.
--
-- Safe to re-run.
-- ============================================================

-- P1 — listWorkspaces() used to fetch the full organization_id column of
-- re_projects/re_units/re_customers/re_reservations/re_payments (five
-- platform-wide tables) just to count rows per org in JavaScript. This
-- returns one row per organization that has ANY of the five, with all five
-- counts already grouped.
create or replace function admin_workspace_counts()
returns table (
  organization_id uuid,
  project_count bigint,
  unit_count bigint,
  customer_count bigint,
  reservation_count bigint,
  payment_count bigint
)
language sql
security definer
set search_path = public
as $$
  select
    o.organization_id,
    coalesce(p.cnt, 0) as project_count,
    coalesce(u.cnt, 0) as unit_count,
    coalesce(c.cnt, 0) as customer_count,
    coalesce(r.cnt, 0) as reservation_count,
    coalesce(pay.cnt, 0) as payment_count
  from (
    select organization_id from re_projects
    union select organization_id from re_units
    union select organization_id from re_customers
    union select organization_id from re_reservations
    union select organization_id from re_payments where voided_at is null
  ) o
  left join (select organization_id, count(*) cnt from re_projects group by organization_id) p
    on p.organization_id = o.organization_id
  left join (select organization_id, count(*) cnt from re_units group by organization_id) u
    on u.organization_id = o.organization_id
  left join (select organization_id, count(*) cnt from re_customers group by organization_id) c
    on c.organization_id = o.organization_id
  left join (select organization_id, count(*) cnt from re_reservations group by organization_id) r
    on r.organization_id = o.organization_id
  left join (select organization_id, count(*) cnt from re_payments where voided_at is null group by organization_id) pay
    on pay.organization_id = o.organization_id;
$$;

-- P2 — overview() used to fetch the `amount` column of every non-voided
-- payment on the whole platform just to sum it in JavaScript.
create or replace function admin_total_collections()
returns numeric
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0) from re_payments where voided_at is null;
$$;

-- P3 — notificationStats() used to fetch the `channel` column of the
-- entire re_notifications table (append-only, retained forever) just to
-- bucket counts by channel in JavaScript.
create or replace function admin_notification_counts_by_channel()
returns table (channel text, cnt bigint)
language sql
security definer
set search_path = public
as $$
  select channel, count(*) as cnt from re_notifications group by channel;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant execute on function admin_workspace_counts() to service_role;
  grant execute on function admin_total_collections() to service_role;
  grant execute on function admin_notification_counts_by_channel() to service_role;
end $$;
