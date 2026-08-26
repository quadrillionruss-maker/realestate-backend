// defaultRiskService.js — SECTION 5 (feature expansion): a 0-100 default
// risk score per ACTIVE RESERVATION, higher meaning MORE likely to default.
//
// Deliberately separate from creditScoreService.js's 0-100 credit_score
// (higher meaning LESS risky, scored per BUYER across every deal they have)
// rather than folded into it: this is per-reservation (a buyer with two
// units can be current on one and sliding on the other) and reads five
// different signals the product spec asked for by name, three of which
// credit_score does not compute at all (payment-gap trend, escalation
// VELOCITY rather than current stage, and activity-log response rate as
// its own dimension rather than an escalation-stage proxy).
//
// Five weighted RISK contributions (0 risk = no evidence of a problem on
// that dimension — same "nothing on record is not a penalty" philosophy
// creditScoreService already uses):
//
//   30  Payment trend — the gap between the last 3 payments growing
//       (paying less often over time) vs. shrinking or steady.
//   20  Timing — days the earliest unpaid installment is past its due
//       date right now, capped at 20 (one point per day late).
//   20  Promise reliability — broken ÷ resolved payment promises on this
//       reservation's own installments.
//   15  Escalation velocity — how quickly this reservation reached its
//       CURRENT escalation stage after being created, not just which
//       stage it is at. APPROXIMATION: the schema keeps one escalated_at
//       timestamp for the current stage, not a full transition history,
//       so "velocity" is read as (time from reservation creation to
//       reaching this stage) rather than (time between stage N and N+1).
//   15  Response rate — of this buyer's logged activities that carry an
//       outcome at all, how many were "no answer" vs. an actual response.
//
// A reservation with none of these five signals yet (brand new, nothing
// due, no promises, never escalated, no activity logged) scores 0 — no
// risk on record, not a penalty for being new.
const { supabaseAdmin } = require('../middleware/orgContext');
const { STAGES } = require('./escalationService');
const { lagosToday } = require('./overdueService');

const WEIGHTS = { trend: 30, timing: 20, promises: 20, velocity: 15, response: 15 };
const HIGH_RISK_THRESHOLD = 70;

// Escalating within this many days of the reservation being created reads
// as maximally fast (full velocity risk); beyond this many days reads as
// slow enough to carry none. Between the two, risk scales linearly.
// 30/180 mirror escalationService's own fastest/slowest realistic windows —
// its 'reminder' stage starts at 1 day overdue and 'legal' territory is
// months of arrears, so a reservation escalating within its first month is
// a materially different story from one that took most of a year.
const FAST_ESCALATION_DAYS = 30;
const SLOW_ESCALATION_DAYS = 180;

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const daysBetween = (fromISO, toISO) => (Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000;

async function loadReservationHistory(orgId, reservationId) {
  const { data: reservation, error: resErr } = await supabaseAdmin
    .from('re_reservations')
    .select(`
      id, customer_id, created_at, escalation_stage, escalated_at, status,
      re_installment_plans(
        id, status,
        re_installment_schedule(id, due_date, status, paid_at, amount_due)
      )
    `)
    .eq('id', reservationId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (resErr) throw resErr;
  if (!reservation) return null;

  const scheduleIds = asArray(reservation.re_installment_plans)
    .flatMap((plan) => asArray(plan.re_installment_schedule).map((row) => row.id));

  const [{ data: payments, error: payErr }, { data: promises, error: promErr }, { data: activities, error: actErr }] = await Promise.all([
    scheduleIds.length
      ? supabaseAdmin.from('re_payments')
          .select('paid_at, re_installment_schedule!inner(id)')
          .eq('organization_id', orgId)
          .in('re_installment_schedule.id', scheduleIds)
          .is('voided_at', null)
          // AUDIT FIX (F5) — a reallocation row's paid_at is set to whenever
          // staff processed the reallocation (an arbitrary back-office
          // action time), not when the buyer actually paid. Counting it as
          // a real payment event double-counts one genuine transfer and
          // skews the payment-trend signal — the same exclusion
          // receiptService.js/commissionService.js already apply when
          // summing "real" payments.
          .is('reallocated_from_payment_id', null)
          .order('paid_at', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    scheduleIds.length
      ? supabaseAdmin.from('re_payment_promises')
          .select('status, schedule_id')
          .eq('organization_id', orgId)
          .in('schedule_id', scheduleIds)
      : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from('re_activities')
      .select('outcome')
      .eq('organization_id', orgId)
      .eq('customer_id', reservation.customer_id)
      .is('deleted_at', null),
  ]);
  if (payErr) throw payErr;
  if (promErr) throw promErr;
  if (actErr) throw actErr;

  return { reservation, payments: payments || [], promises: promises || [], activities: activities || [] };
}

function computeFromHistory({ reservation, payments, promises, activities }, today = lagosToday()) {
  // ── 1. Payment trend ───────────────────────────────────────────────────
  const paidDates = payments.map((p) => p.paid_at).filter(Boolean).sort();
  const last3 = paidDates.slice(-3);
  let trendRisk = 0;
  let trendDetail = { evidence: last3.length >= 3 };
  if (last3.length >= 3) {
    const gap1 = daysBetween(last3[0], last3[1]);
    const gap2 = daysBetween(last3[1], last3[2]);
    if (gap2 > gap1) {
      const growth = gap1 > 0 ? gap2 / gap1 : (gap2 > 0 ? 2 : 1);
      const safetyRatio = Math.max(0, Math.min(1, 1 / growth));
      trendRisk = Math.round(WEIGHTS.trend * (1 - safetyRatio));
    }
    trendDetail = { evidence: true, previous_gap_days: Math.round(gap1), latest_gap_days: Math.round(gap2), growing: gap2 > gap1 };
  }

  // ── 2. Timing — the earliest unpaid installment, if any ────────────────
  const dueRows = asArray(reservation.re_installment_plans)
    .flatMap((plan) => asArray(plan.re_installment_schedule))
    .filter((row) => row.status === 'pending' || row.status === 'overdue')
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  let timingRisk = 0;
  let daysLate = 0;
  if (dueRows.length) {
    daysLate = Math.round(daysBetween(dueRows[0].due_date, today));
    timingRisk = Math.max(0, Math.min(WEIGHTS.timing, daysLate));
  }

  // ── 3. Promise reliability ──────────────────────────────────────────────
  const kept = promises.filter((p) => p.status === 'kept').length;
  const broken = promises.filter((p) => p.status === 'broken').length;
  const resolvedPromises = kept + broken;
  const promiseRisk = resolvedPromises ? Math.round(WEIGHTS.promises * (broken / resolvedPromises)) : 0;

  // ── 4. Escalation velocity ──────────────────────────────────────────────
  const stageIndex = STAGES.findIndex((s) => s.key === (reservation.escalation_stage || 'none'));
  let velocityRisk = 0;
  let daysToEscalate = null;
  if (stageIndex > 0 && reservation.escalated_at) {
    daysToEscalate = Math.max(1, Math.round(daysBetween(reservation.created_at, reservation.escalated_at)));
    const fastness = Math.max(0, Math.min(1,
      (SLOW_ESCALATION_DAYS - daysToEscalate) / (SLOW_ESCALATION_DAYS - FAST_ESCALATION_DAYS)));
    velocityRisk = Math.round(WEIGHTS.velocity * fastness);
  }

  // ── 5. Response rate ─────────────────────────────────────────────────────
  const responded = activities.filter((a) => a.outcome === 'interested' || a.outcome === 'promised_payment').length;
  const noResponse = activities.filter((a) => a.outcome === 'no_answer').length;
  const responseSignal = responded + noResponse;
  const responseRisk = responseSignal ? Math.round(WEIGHTS.response * (noResponse / responseSignal)) : 0;

  const score = Math.max(0, Math.min(100, trendRisk + timingRisk + promiseRisk + velocityRisk + responseRisk));

  return {
    score,
    breakdown: {
      payment_trend: { risk_points: trendRisk, of: WEIGHTS.trend, ...trendDetail },
      timing: { risk_points: timingRisk, of: WEIGHTS.timing, days_late: daysLate },
      promise_reliability: { risk_points: promiseRisk, of: WEIGHTS.promises, kept, broken, resolved: resolvedPromises },
      escalation_velocity: {
        risk_points: velocityRisk, of: WEIGHTS.velocity,
        escalation_stage: reservation.escalation_stage || 'none', days_to_escalate: daysToEscalate,
      },
      response_rate: { risk_points: responseRisk, of: WEIGHTS.response, responded, no_response: noResponse },
    },
  };
}

async function computeBreakdown(orgId, reservationId) {
  const history = await loadReservationHistory(orgId, reservationId);
  if (!history) return null;
  return computeFromHistory(history);
}

// Called after every payment event (paymentEvents.onPaymentRecorded) — never
// throws, same rule as creditScoreService.recompute and everything else in
// that file: a derived figure failing to update must not fail the payment
// that triggered it.
async function recompute(orgId, reservationId) {
  if (!orgId || !reservationId) return null;
  try {
    const result = await computeBreakdown(orgId, reservationId);
    if (!result) return null;
    await supabaseAdmin
      .from('re_reservations')
      .update({ default_risk_score: result.score })
      .eq('id', reservationId)
      .eq('organization_id', orgId);
    return result.score;
  } catch (err) {
    console.warn('[default-risk] could not recompute:', err.message);
    return null;
  }
}

// The morning brief's "Likely to default this month" — the three live
// reservations (not cancelled, not completed) with the highest STORED
// score, computed fresh at every payment rather than recomputed live for
// every reservation in the org on every brief run.
async function topDefaultRisks(orgId, limit = 3) {
  const { data, error } = await supabaseAdmin
    .from('re_reservations')
    .select('id, default_risk_score, re_customers(id, full_name), re_units(unit_number, re_projects(name))')
    .eq('organization_id', orgId)
    .in('status', ['reserved', 'confirmed'])
    .gt('default_risk_score', HIGH_RISK_THRESHOLD)
    .order('default_risk_score', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((r) => ({
    reservation_id: r.id,
    customer_id: r.re_customers?.id || null,
    customer_name: r.re_customers?.full_name || 'Unknown buyer',
    unit_number: r.re_units?.unit_number || null,
    project: r.re_units?.re_projects?.name || null,
    default_risk_score: r.default_risk_score,
  }));
}

module.exports = {
  WEIGHTS, HIGH_RISK_THRESHOLD, computeFromHistory, computeBreakdown, recompute, topDefaultRisks,
};
