-- ============================================================
-- PROMPT 8 — Unified Approval/Workflow Engine. One place to see every
-- sensitive, role-gated decision across the product — today: hardship
-- (payment pause), bank financing, plan restructures, and bulk-waived
-- installments — src/services/approvalService.js owns every write; the four
-- source services (hardshipService, financingService, restructureService,
-- routes/payments.js's bulk-waive) call into it, never the other way
-- around, same "record what happened, never gate it" instrumentation
-- philosophy re_decision_ledger and re_action_outcomes already establish.
--
-- ── Two genuinely different shapes, one table ─────────────────────────────
-- hardship and financing are real two-party flows already: a buyer (or
-- staff) SUBMITS from the portal, a director/owner DECIDES later — a real
-- 'pending' row is written at submission and closed at decision, from
-- whichever route actually makes the decision (the existing
-- PATCH /hardship-requests/:id/review and PATCH /financing-requests/:id, as
-- well as this table's own POST /approvals/:id/approve|reject), so this
-- table is never the only place a decision can be recorded — see
-- approvalService.closeForEntity's own comment.
--
-- restructure and bulk-waive have NO separate request/decide split today —
-- CLAUDE.md's "Renegotiating a plan" describes restructure as a direct
-- owner/sales-director action, and routes/payments.js's own bulk-waive
-- route is a single OWNER-gated call with a dry_run PREVIEW, not a request
-- sent to a second person. Retrofitting a real blocking pre-approval gate
-- onto either would be a materially different, invasive product change
-- nobody asked for here — so a row for either is written ALREADY resolved
-- (status='approved', approvals_received already carries the one actor who
-- both requested and decided it), purely so all four show up in the same
-- history. Only hardship/financing rows are ever found 'pending'.
--
-- ── Columns ─────────────────────────────────────────────────────────────
-- request_type carries three reserved values (payment_plan_modification,
-- joint_sale, undo_action) not wired to any trigger in this pass — same
-- "reserved, not yet wired" convention re_decision_ledger's own
-- recommendation_type already uses for escalation/document_action.
--
-- entity_type/entity_id point at the SOURCE row (re_hardship_requests,
-- re_financing_requests, re_reservations for a restructure,
-- re_installment_schedule per waived installment — one row per waived
-- installment, not one per bulk call, matching the granularity
-- routes/payments.js's own audit() calls already use in that same loop).
--
-- requested_by is nullable: hardship/financing are almost always submitted
-- from the BUYER portal (re_customers, not a users row at all — the same
-- reason re_hardship_requests itself carries requested_by_portal rather
-- than a staff user FK) — the real requester in that case is already on the
-- source row's own customer_id, not duplicated here.
--
-- approval_chain/approvals_received are jsonb arrays so a real multi-step
-- chain (e.g. sales_director then owner) can be introduced later with no
-- schema change — every chain written by this pass is a single role, since
-- that is what every one of these four actions actually requires today
-- (permissions.js: hardship.review/reservations.restructure are DIRECTORS,
-- financing.manage/payments.waive are OWNER).
--
-- No deleted_at — append-only evidence, same as re_decision_ledger/
-- re_action_outcomes/re_audit_log.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_approval_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_type text not null check (request_type in (
    'payment_plan_modification', 'restructure', 'hardship', 'financing',
    'joint_sale', 'bulk_waive', 'undo_action'
  )),
  entity_type text not null,
  entity_id uuid not null,
  requested_by uuid references users(id) on delete set null,
  requested_at timestamptz not null default now(),
  current_approver_role text not null check (current_approver_role in ('sales_director', 'owner')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  approval_chain jsonb not null default '[]'::jsonb,
  approvals_received jsonb not null default '[]'::jsonb,
  rejection_reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_re_approval_requests_org_status
  on re_approval_requests(organization_id, status, requested_at desc);
-- A safety net, not the only thing preventing a double-pending row — the
-- source tables (re_hardship_requests, migrations/030) already enforce
-- their own "one pending request" rule independently.
create unique index if not exists idx_re_approval_requests_entity_pending
  on re_approval_requests(organization_id, entity_type, entity_id)
  where status = 'pending';

alter table re_approval_requests enable row level security;
drop policy if exists "org members access re_approval_requests" on re_approval_requests;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_approval_requests to service_role;
  revoke all on public.re_approval_requests from anon, authenticated;
end $$;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('092_approval_requests.sql')
  on conflict (filename) do nothing;
