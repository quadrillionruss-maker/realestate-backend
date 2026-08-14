// escalationService.js — one missed payment is not five missed payments.
//
// The brief used to flag every overdue buyer the same way, which is not how
// any developer actually behaves. One missed installment gets a warm WhatsApp
// nudge. Three gets a formal letter. Five gets the legal team. Sending the
// legal wording to someone who was travelling, or the warm nudge to someone
// eight months in arrears, are both expensive mistakes.
//
// The stage lives on the RESERVATION, not the installment, because it
// describes the relationship rather than a single missed date.
//
// Stages are advisory: they set the tone of the drafted message and sort the
// morning list. Nothing here cancels a reservation or takes legal action — a
// human does that, which is the same rule every AI output in this product
// follows (docs/AI_WORKFORCE.md).

const { supabaseAdmin } = require('../middleware/orgContext');
const { auditSystem } = require('./auditService');
const { mapWithConcurrency } = require('../utils/concurrency');

const ESCALATION_CONCURRENCY = 8;

// Thresholds are counts of overdue installments. They are deliberately
// conservative: escalating too fast costs a developer a buyer who was simply
// slow, and buyers who are slow are most of them.
const STAGES = [
  {
    key: 'none',
    minOverdue: 0,
    label: 'Current',
    tone: 'friendly',
    guidance: 'No arrears. Nothing to chase.',
  },
  {
    key: 'reminder',
    minOverdue: 1,
    label: 'Reminder',
    tone: 'warm and brief',
    guidance: 'Assume they simply forgot. Be warm, mention the amount and the date, offer to resend account details. Do not mention consequences.',
  },
  {
    key: 'formal_notice',
    minOverdue: 3,
    label: 'Formal notice',
    tone: 'polite but formal',
    guidance: 'Reference the contract of sale and the total arrears. Ask for a specific date. Still cooperative in tone, but clearly a record of the request.',
  },
  {
    key: 'final_notice',
    minOverdue: 5,
    label: 'Final notice',
    tone: 'formal and direct',
    guidance: 'State the arrears total and that the allocation is at risk under the terms of the contract. Request a payment plan or full settlement by a stated date.',
  },
  {
    key: 'legal',
    minOverdue: 7,
    label: 'Legal review',
    tone: 'formal, factual, no warmth',
    guidance: 'Do not draft a message. Recommend handing the file to the legal team; anything sent from here can be read back in court.',
  },
];

const byKey = new Map(STAGES.map((stage) => [stage.key, stage]));

// FEATURE — the at-risk list (routes/dashboard.js's GET /at-risk) used to
// require 2+ overdue installments before a buyer surfaced there at all,
// which meant a rep's very first missed payment went unflagged on the one
// screen a collections officer actually works every morning. One overdue
// installment is now enough — it already carries the 'reminder' escalation
// stage (STAGES above), so this is "list every buyer who has been
// escalated at all", not a separate judgment call. Named here, not as a
// bare `>= 1` in the route, so the one number the at-risk screen, its KPI
// tile and this file's own tests all agree on lives in exactly one place.
const AT_RISK_MIN_OVERDUE = 1;
const isAtRisk = (overdueCount) => Number(overdueCount || 0) >= AT_RISK_MIN_OVERDUE;

// Highest threshold the count clears.
function stageForOverdueCount(count) {
  let match = STAGES[0];
  for (const stage of STAGES) {
    if (count >= stage.minOverdue) match = stage;
  }
  return match;
}

const describeStage = (key) => byKey.get(key) || STAGES[0];

// Run by the morning job before the brief, so "formal notice" means the same
// thing to the dashboard, the at-risk list and the AI.
//
// Only ever raises a stage or leaves it alone. Lowering it is the payment
// path's job (paymentEvents.maybeDeescalate) — money is the only thing that
// should calm this down.
async function sweepEscalations(orgId = null) {
  let query = supabaseAdmin
    .from('re_installment_schedule')
    .select('id, plan_id, organization_id, re_installment_plans!inner(reservation_id)')
    .eq('status', 'overdue');
  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query;
  if (error) throw error;

  const overdueByReservation = new Map();
  for (const row of data || []) {
    const reservationId = row.re_installment_plans?.reservation_id;
    if (!reservationId) continue;
    const entry = overdueByReservation.get(reservationId) || { count: 0, orgId: row.organization_id };
    entry.count += 1;
    overdueByReservation.set(reservationId, entry);
  }

  if (!overdueByReservation.size) return { evaluated: 0, raised: 0 };

  const ids = [...overdueByReservation.keys()];
  const { data: reservations, error: resErr } = await supabaseAdmin
    .from('re_reservations')
    .select('id, organization_id, escalation_stage, status')
    .in('id', ids);
  if (resErr) throw resErr;

  let raised = 0;
  const now = new Date().toISOString();

  // Each reservation moves to its own target stage, so this isn't one bulk
  // UPDATE the way the promise sweep's is — but the update and its audit
  // entry for one buyer have nothing to do with the next buyer's, and this
  // sweep runs across every organization in one call, so hundreds of these
  // used to go out strictly one at a time.
  await mapWithConcurrency(reservations || [], ESCALATION_CONCURRENCY, async (reservation) => {
    // A cancelled reservation has no arrears worth escalating.
    if (reservation.status === 'cancelled' || reservation.status === 'completed') return;

    const overdue = overdueByReservation.get(reservation.id);
    // Defense in depth: this id list came from an org-scoped query already
    // (UUID primary keys aren't guessable, so this isn't exploitable today),
    // but nothing otherwise re-confirms that the row this update is about to
    // touch belongs to the org its own count was computed against — cheap
    // to assert explicitly rather than trust two queries to agree forever.
    if (!overdue || overdue.orgId !== reservation.organization_id) return;

    const { count } = overdue;
    const target = stageForOverdueCount(count);
    const current = describeStage(reservation.escalation_stage);

    if (STAGES.indexOf(target) <= STAGES.indexOf(current)) return;

    const { error: updateErr } = await supabaseAdmin
      .from('re_reservations')
      .update({ escalation_stage: target.key, escalated_at: now })
      .eq('id', reservation.id)
      .eq('organization_id', reservation.organization_id);
    if (updateErr) {
      console.warn('[escalation] could not raise stage:', updateErr.message);
      return;
    }

    raised += 1;
    await auditSystem({
      orgId: reservation.organization_id,
      actorKind: 'system',
      action: 'reservation.escalated',
      entityType: 're_reservations',
      entityId: reservation.id,
      summary: `Escalated from ${current.label} to ${target.label} — ${count} overdue installments`,
      metadata: { from: current.key, to: target.key, overdue_count: count },
    });
  });

  return { evaluated: overdueByReservation.size, raised };
}

module.exports = {
  STAGES, stageForOverdueCount, describeStage, sweepEscalations, AT_RISK_MIN_OVERDUE, isAtRisk,
};
