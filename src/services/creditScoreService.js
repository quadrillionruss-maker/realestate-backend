// creditScoreService.js — SECTION 3: a 0-100 buyer score built entirely
// from data already in Archta. No new inputs, no external bureau, no API.
//
// Four dimensions, weighted per the product spec:
//   40  Payment consistency — on-time paid installments ÷ installments
//       that have actually reached their due date. A 'pending' row not
//       yet due has not had a chance to be early or late, so it counts
//       toward neither side of the ratio.
//   20  Promise reliability — kept promises ÷ resolved promises
//       (kept + broken). An 'open' promise hasn't resolved either way
//       yet, and a 'cancelled' one was withdrawn, not broken.
//   20  Response rate — this product does not yet track a buyer's actual
//       replies (that lands with SECTION 9's WhatsApp webhook), so this
//       is proxied from escalation stage, exactly as the spec directs:
//       a reservation sitting at a low stage means whatever prompted
//       escalation got resolved before it climbed further; stuck at
//       'legal' reads as the floor.
//   20  Default history — how many installments have EVER been late.
//       Status alone only remembers the CURRENT state, not "was overdue
//       and later paid", so a row currently 'overdue' or paid AFTER its
//       due date both count as one default event.
//
// A buyer with no evidence yet in a dimension (nothing due, no resolved
// promises, no reservation at all) scores full marks on it — "nothing on
// record" reads as "no problem on record", not as a penalty for being new.
const { supabaseAdmin } = require('../middleware/orgContext');
const { STAGES, describeStage } = require('./escalationService');
const { isPastDue } = require('./overdueService');

const WEIGHTS = { consistency: 40, promises: 20, response: 20, defaults: 20 };

// FEATURE — payment pause / hardship mode. Not one of the four weighted
// dimensions above: those all measure behaviour that happened on its own,
// while this is a flat penalty for a specific event (an APPROVED hardship
// request — migrations/030), applied once per approval and stacking if a
// buyer has used it on more than one reservation.
const HARDSHIP_PENALTY = 15;

// Ceiling for "as bad as the default-history dimension can read". Five is
// not arbitrary — escalationService's own thresholds put five overdue
// installments at 'final_notice', so five default EVENTS (which include
// paid-late rows a live reservation may no longer even show as overdue)
// is already a comparably serious history.
const DEFAULT_EVENTS_FLOOR = 5;

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

async function loadCustomerHistory(orgId, customerId) {
  const [{ data: reservations, error: resErr }, { data: promises, error: promErr }, { data: hardship, error: hardshipErr }] = await Promise.all([
    supabaseAdmin
      .from('re_reservations')
      .select(`
        id, escalation_stage, status,
        re_installment_plans(re_installment_schedule(id, due_date, status, paid_at))
      `)
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .neq('status', 'cancelled'),
    supabaseAdmin
      .from('re_payment_promises')
      .select('status')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId),
    supabaseAdmin
      .from('re_hardship_requests')
      .select('id')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .eq('status', 'approved'),
  ]);
  if (resErr) throw resErr;
  if (promErr) throw promErr;
  if (hardshipErr) throw hardshipErr;
  return { reservations: reservations || [], promises: promises || [], hardshipCount: hardship?.length || 0 };
}

function computeFromHistory({ reservations, promises, hardshipCount = 0 }) {
  let dueCount = 0;
  let onTimeCount = 0;
  let defaultEvents = 0;
  let worstStageIndex = 0;

  for (const reservation of reservations) {
    const stageIndex = STAGES.findIndex((s) => s.key === (reservation.escalation_stage || 'none'));
    if (stageIndex > worstStageIndex) worstStageIndex = stageIndex;

    for (const plan of asArray(reservation.re_installment_plans)) {
      for (const row of plan.re_installment_schedule || []) {
        if (row.status === 'paid') {
          dueCount += 1;
          onTimeCount += 1; // TASK 2.15 — the denominator now includes every paid row, not just on-time ones (see below)
          // Dates only — paid_at is a timestamp, due_date a plain date;
          // comparing the date portion is what "on time" means here, not
          // "before midnight down to the second". Still tracked as a
          // default event even though it now also counts as "paid" above —
          // paying late is still a default, it just isn't an UNRESOLVED one.
          const paidOnDate = String(row.paid_at || '').slice(0, 10);
          const dueDate = row.due_date;
          if (!(paidOnDate && dueDate && paidOnDate <= dueDate)) defaultEvents += 1;
        } else if (row.status === 'overdue') {
          dueCount += 1;
          defaultEvents += 1;
        } else if (row.status === 'pending' && isPastDue(row.due_date)) {
          // TASK 2.15 — the bug: a row whose due_date has passed the 18:00
          // Lagos cutoff (overdueService.isPastDue, the same rule
          // markOverdue itself sweeps by) but that sweep has not yet run
          // against was previously invisible to this whole dimension —
          // neither due nor paid, so a buyer could rack up days of
          // unrecorded lateness and still show a perfect consistency score
          // in the gap between "the payment missed its due date" and
          // "tonight's/tomorrow's cron catches up". Counted here exactly
          // like an 'overdue' row: due, unresolved, a default event.
          dueCount += 1;
          defaultEvents += 1;
        }
        // A 'pending' row not yet past due, and a 'waived' row, are neither
        // paid nor late — they have not (or will not) come due at all.
      }
    }
  }

  // "on_time"/"total_due" are the field names financingService.js's
  // eligibility check already reads (breakdown.payment_consistency.on_time /
  // .total_due) — kept as-is rather than renamed, but on_time's own meaning
  // has shifted: it is every PAID installment now (paid.count above),
  // divided by every installment that has actually come due (paid +
  // overdue + pending-past-due), matching the product spec's formula
  // exactly. A late-paid installment still counts against defaultEvents
  // above; it is simply no longer invisible to this ratio the way an
  // unswept pending-past-due row used to be.
  const consistencyRatio = dueCount ? onTimeCount / dueCount : 1;
  const consistencyPoints = Math.round(WEIGHTS.consistency * consistencyRatio);

  const kept = promises.filter((p) => p.status === 'kept').length;
  const broken = promises.filter((p) => p.status === 'broken').length;
  const resolvedPromises = kept + broken;
  const promiseRatio = resolvedPromises ? kept / resolvedPromises : 1;
  const promisePoints = Math.round(WEIGHTS.promises * promiseRatio);

  const responseRatio = 1 - worstStageIndex / (STAGES.length - 1);
  const responsePoints = Math.round(WEIGHTS.response * responseRatio);

  const defaultRatio = Math.max(0, 1 - defaultEvents / DEFAULT_EVENTS_FLOOR);
  const defaultPoints = Math.round(WEIGHTS.defaults * defaultRatio);

  const hardshipPoints = -(HARDSHIP_PENALTY * Math.max(0, hardshipCount));
  const score = Math.max(0, Math.min(100,
    consistencyPoints + promisePoints + responsePoints + defaultPoints + hardshipPoints));

  return {
    score,
    breakdown: {
      payment_consistency: {
        points: consistencyPoints, of: WEIGHTS.consistency,
        on_time: onTimeCount, total_due: dueCount,
      },
      promise_reliability: {
        points: promisePoints, of: WEIGHTS.promises,
        kept, resolved: resolvedPromises,
      },
      response_rate: {
        points: responsePoints, of: WEIGHTS.response,
        worst_escalation_stage: describeStage(STAGES[worstStageIndex]?.key).label,
      },
      default_history: {
        points: defaultPoints, of: WEIGHTS.defaults,
        default_events: defaultEvents,
      },
      hardship_penalty: {
        points: hardshipPoints, per_use: -HARDSHIP_PENALTY, uses: Math.max(0, hardshipCount),
      },
    },
  };
}

async function computeBreakdown(orgId, customerId) {
  const history = await loadCustomerHistory(orgId, customerId);
  return computeFromHistory(history);
}

// Called after every payment event and every promise resolution (see
// paymentEvents.onPaymentRecorded and promiseService.resolvePromise /
// sweepBrokenPromises) — never throws, matching this product's rule that a
// side-effect updating a derived figure must not fail the operation that
// triggered it.
async function recompute(orgId, customerId) {
  if (!orgId || !customerId) return null;
  try {
    const { score } = await computeBreakdown(orgId, customerId);
    await supabaseAdmin
      .from('re_customers')
      .update({ credit_score: score })
      .eq('id', customerId)
      .eq('organization_id', orgId);
    return score;
  } catch (err) {
    console.warn('[credit-score] could not recompute:', err.message);
    return null;
  }
}

// 80-100 Excellent, 60-79 Good, 40-59 Fair, 0-39 At risk — per the product
// spec. Colour-wise this product's own palette (CLAUDE.md: "colour carries
// state and nothing else") has exactly three status tones — moss (good),
// gold (caution/pending), clay (bad) — not four, and the spec's own
// parenthetical colours for the top two tiers ("green" / "moss") are the
// same family. Excellent and Good both read as moss, distinguished by the
// number itself; Fair reads as the existing caution tone; At risk reads as
// the existing bad-news tone. No new hue was invented for this feature.
function tier(score) {
  if (score >= 80) return { key: 'excellent', label: 'Excellent' };
  if (score >= 60) return { key: 'good', label: 'Good' };
  if (score >= 40) return { key: 'fair', label: 'Fair' };
  return { key: 'at_risk', label: 'At risk' };
}

module.exports = { WEIGHTS, HARDSHIP_PENALTY, computeFromHistory, computeBreakdown, recompute, tier };
