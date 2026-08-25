// contactTimingService.js — SECTION 6 (feature expansion): when a buyer is
// actually reachable, learned from their own history rather than assumed.
//
// Two signals, both read in Africa/Lagos local time (overdueService's own
// lagosParts, reused rather than re-derived — this file has no business
// doing its own UTC-offset arithmetic when that helper already exists and
// is what every other date decision in this product goes through):
//
//   optimal_contact_day   the day of the week (0-6, MONDAY=0 — the product
//                         spec's own convention, the opposite of
//                         JavaScript's native Sunday=0) this buyer's
//                         payments most often land on.
//   optimal_contact_hour  the Lagos-local hour this buyer is most often
//                         actually reached — read from activity-log entries
//                         with a real outcome (a rep spoke to them) when
//                         any exist, since that is direct evidence of
//                         reachability; payment hours otherwise, since a
//                         payment is still evidence of engagement.
//
// Fewer than 3 payments (MIN_PAYMENTS_FOR_PATTERN, the product spec's own
// threshold) is "no pattern yet" — both come back null, and the caller
// (collectionsAgent.js) falls back to the default send time, exactly as
// asked. This mirrors creditScoreService/defaultRiskService's own rule that
// an absence of evidence must never itself read as a signal.
const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosParts } = require('./overdueService');

const MIN_PAYMENTS_FOR_PATTERN = 3;

// JS's Date.getUTCDay() is 0=Sunday..6=Saturday. The product spec wants
// 0=Monday..6=Sunday. This is the one place that conversion happens.
function jsDayToMonday0(jsDay) {
  return (jsDay + 6) % 7;
}

function monday0ToJsDay(monday0) {
  return (monday0 + 1) % 7;
}

function lagosDayOfWeek(isoString) {
  const { date } = lagosParts(new Date(isoString));
  // Noon UTC on the already-Lagos-correct calendar date: parsing a bare
  // YYYY-MM-DD as UTC midnight is safe here because the date STRING itself
  // is already what lagosParts resolved it to — there is no timezone left
  // to get wrong, only which day-of-week that calendar date falls on.
  return jsDayToMonday0(new Date(`${date}T12:00:00Z`).getUTCDay());
}

function lagosHour(isoString) {
  return lagosParts(new Date(isoString)).hour;
}

// The most frequent value in a list of small integers (a day-of-week or an
// hour) — ties broken by whichever value was seen first, which is
// deterministic (payments/activities always arrive sorted) rather than
// dependent on Map iteration order happening to agree with intent.
function mode(values) {
  if (!values.length) return null;
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (const v of values) {
    const count = (counts.get(v) || 0) + 1;
    counts.set(v, count);
    if (count > bestCount) { best = v; bestCount = count; }
  }
  return best;
}

// Pure — payments/activities are flat arrays of { paid_at } / { outcome,
// created_at }, exactly what loadContactHistory below hands it, so this is
// directly unit-testable without a database.
function computeOptimalContact({ payments = [], activities = [] }) {
  if (payments.length < MIN_PAYMENTS_FOR_PATTERN) {
    return { day: null, hour: null };
  }

  const day = mode(payments.map((p) => lagosDayOfWeek(p.paid_at)));

  const responded = activities.filter((a) => a.outcome && a.outcome !== 'no_answer' && a.created_at);
  const hourSource = responded.length
    ? responded.map((a) => lagosHour(a.created_at))
    : payments.map((p) => lagosHour(p.paid_at));
  const hour = mode(hourSource);

  return { day, hour };
}

async function loadContactHistory(orgId, customerId) {
  const [{ data: payments, error: payErr }, { data: activities, error: actErr }] = await Promise.all([
    supabaseAdmin
      .from('re_payments')
      .select('paid_at, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(customer_id)))')
      .eq('organization_id', orgId)
      .eq('re_installment_schedule.re_installment_plans.re_reservations.customer_id', customerId)
      .is('voided_at', null)
      .order('paid_at', { ascending: true }),
    supabaseAdmin
      .from('re_activities')
      .select('outcome, created_at')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .is('deleted_at', null),
  ]);
  if (payErr) throw payErr;
  if (actErr) throw actErr;
  return { payments: (payments || []).filter((p) => p.paid_at), activities: activities || [] };
}

// Called after every payment event and every activity logged — never
// throws, same rule every derived-figure recompute in this product follows.
async function recompute(orgId, customerId) {
  if (!orgId || !customerId) return null;
  try {
    const history = await loadContactHistory(orgId, customerId);
    const { day, hour } = computeOptimalContact(history);
    await supabaseAdmin
      .from('re_customers')
      .update({ optimal_contact_day: day, optimal_contact_hour: hour })
      .eq('id', customerId)
      .eq('organization_id', orgId);
    return { day, hour };
  } catch (err) {
    console.warn('[contact-timing] could not recompute:', err.message);
    return null;
  }
}

// The next real UTC instant at which it will be `hour`:00 Lagos-local on
// weekday `day` (0-6, Monday=0), at or after `from`. Used by
// collectionsAgent.js to turn "this buyer's optimal time" into an actual
// re_scheduled_messages.scheduled_for timestamptz.
//
// Lagos is a fixed UTC+1 with no DST (this product's one and only timezone
// rule — see overdueService.js's own header), so "hour H Lagos-local on
// calendar date D" is simply UTC date D at (H-1):00 — no DST table needed,
// which is what makes this safe to compute directly rather than through a
// heavier timezone library.
function nextOccurrenceUTC(day, hour, from = new Date()) {
  if (day == null || hour == null) return null;

  const { date: fromDate, hour: fromHour } = lagosParts(from);
  const targetJsDay = monday0ToJsDay(day);
  const fromJsDay = new Date(`${fromDate}T12:00:00Z`).getUTCDay();

  let daysAhead = (targetJsDay - fromJsDay + 7) % 7;
  // Today IS the target weekday, but its hour has already passed this week.
  if (daysAhead === 0 && fromHour >= hour) daysAhead = 7;

  const targetDate = new Date(Date.parse(`${fromDate}T00:00:00Z`) + daysAhead * 86_400_000)
    .toISOString().slice(0, 10);
  const utcInstant = Date.parse(`${targetDate}T00:00:00Z`) + (hour - 1) * 3_600_000;
  return new Date(utcInstant).toISOString();
}

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// "Tuesday mornings" — the buyer drawer's own hint text, per the product
// spec's exact phrasing. Hour bucketed into the same three parts of day a
// human would actually say out loud, not "14:00".
function describeOptimalContact(day, hour) {
  if (day == null || hour == null) return null;
  const part = hour < 12 ? 'mornings' : hour < 17 ? 'afternoons' : 'evenings';
  return `${DAY_LABELS[day]} ${part}`;
}

module.exports = {
  MIN_PAYMENTS_FOR_PATTERN, computeOptimalContact, recompute, describeOptimalContact,
  jsDayToMonday0, monday0ToJsDay, nextOccurrenceUTC,
};
