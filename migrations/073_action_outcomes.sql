-- ============================================================
-- Outcome database — SECTION 1 of the intelligence/outcome-tracking/AI
-- assistant feature expansion. One row per (action taken toward getting a
-- buyer to pay, and whatever eventually happened because of it).
--
-- ── WHY ONE ROW, NOT TWO ────────────────────────────────────────────────
-- The row is created the moment an action happens (action_type set,
-- outcome_type null — "pending") and closed later in place (outcome_type,
-- outcome_recorded_at, days_to_outcome, amount_recovered set) rather than
-- writing a second "outcome" row that references the first. A pending row
-- IS the open half of the same fact, the same way re_payment_promises has
-- one row per promise that starts 'open' and ends 'kept'/'broken', not a
-- separate promises + promise_resolutions pair.
--
-- ── ATTRIBUTION — source_entity vs. source_action_id vs. attribution_method
-- Some actions close themselves precisely: a promise_recorded row IS the
-- promise (source_entity_type='re_payment_promises', source_entity_id=the
-- promise's own id), so resolving that promise closes this exact row —
-- attribution_method='direct_source_link', no guessing involved. A payment
-- has no such link back to "the WhatsApp that was sent" — the outcome
-- database attributes it to whichever action row is still open (outcome_type
-- is null) and most recent for that customer, attribution_method=
-- 'most_recent_action'. That is inherently a best-effort correlation, not
-- proof of causation (see the "no false causality" rule this table exists
-- under) — attribution_method makes which kind of match produced a given
-- row's outcome externally visible rather than leaving every row looking
-- equally certain. source_action_id (nullable, self-referencing) is for the
-- rarer case where recording THIS outcome is itself a reaction to an earlier
-- action row (e.g. an escalation attributed to a prior contact attempt that
-- did not land) — kept distinct from source_entity_id, which points at the
-- domain row (a promise, a campaign) the action itself came from.
--
-- ── outcome_type: 'ignored' vs 'no_response' ────────────────────────────
-- The product spec that commissioned this table asked for both as separate
-- enum values, then flagged in its own safeguards that the two must not
-- represent the same state and one canonical value should be used instead.
-- 'no_response' is that one value; 'ignored' does not appear in the check
-- constraint below at all — see src/services/outcomeService.js's own header
-- for where this is enforced in code.
--
-- ── escalation_stage_at_action ───────────────────────────────────────────
-- The commissioning spec described this as an integer. re_reservations.
-- escalation_stage (migrations/003) has always been the text key
-- ('none'/'reminder'/'formal_notice'/'final_notice'/'legal') every stage
-- lookup in this codebase already uses (escalationService.STAGES) — stored
-- as the same text key here rather than inventing a parallel integer scale
-- nothing else in the product would recognise.
--
-- ── Not soft-deletable ───────────────────────────────────────────────────
-- Same reasoning re_audit_log and re_notifications (both already exempt —
-- see CLAUDE.md's "Nothing is ever deleted") and re_agent_actions
-- (migrations/028) already establish: this is an evidence trail an owner
-- reads analytics off of, not a live record a soft-delete cascade should
-- ever need to hide.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_action_outcomes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null references re_customers(id) on delete cascade,
  reservation_id uuid references re_reservations(id) on delete set null,

  action_type text not null check (action_type in (
    'whatsapp_sent', 'email_sent', 'call_logged', 'promise_recorded',
    'agent_followup', 'campaign_sent', 'restructure_offered'
  )),
  action_taken_at timestamptz not null default now(),
  channel text check (channel in ('whatsapp', 'email', 'sms', 'call')),

  -- What this action row actually came from, when there is a precise
  -- source to point at — see the header above.
  source_entity_type text,
  source_entity_id uuid,
  source_action_id uuid references re_action_outcomes(id) on delete set null,
  attribution_method text check (attribution_method in (
    'direct_source_link', 'most_recent_action', 'sweep_closure'
  )),

  outcome_type text check (outcome_type in (
    'paid_within_24h', 'paid_within_7d', 'paid_within_30d',
    'replied_no_payment', 'no_response',
    'promised_kept', 'promised_broken',
    'restructured', 'escalated'
  )),
  outcome_recorded_at timestamptz,
  days_to_outcome integer,
  amount_recovered numeric(14, 2),

  -- Snapshotted at action_taken_at, not read live off the buyer/reservation
  -- later — an analytics query asking "how did WhatsApp perform for buyers
  -- who were 30+ days overdue at the time" must not have every historical
  -- row's answer silently drift as that same buyer's CURRENT arrears change.
  buyer_days_overdue_at_action integer,
  buyer_credit_score_at_action integer,
  escalation_stage_at_action text,

  created_at timestamptz not null default now(),

  constraint re_action_outcomes_outcome_needs_recorded_at
    check ((outcome_type is null) = (outcome_recorded_at is null)),
  constraint re_action_outcomes_days_to_outcome_non_negative
    check (days_to_outcome is null or days_to_outcome >= 0)
);

-- The two queries every caller actually makes: "what is this customer's
-- most recent OPEN action" (payment/escalation attribution, outcome_type is
-- null) and "every outcome for this org" (the analytics route).
create index if not exists idx_re_action_outcomes_customer_open
  on re_action_outcomes(customer_id, action_taken_at desc) where outcome_type is null;
create index if not exists idx_re_action_outcomes_org_action
  on re_action_outcomes(organization_id, action_type, outcome_type);
-- The nightly no-response sweep's own query: every still-open row past a
-- cutoff, across every org in one pass.
create index if not exists idx_re_action_outcomes_open_taken_at
  on re_action_outcomes(action_taken_at) where outcome_type is null;

alter table re_action_outcomes enable row level security;
drop policy if exists "org members access re_action_outcomes" on re_action_outcomes;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_action_outcomes to service_role;
  revoke all on public.re_action_outcomes from anon, authenticated;
end $$;
