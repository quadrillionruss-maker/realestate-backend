// commissionService.js — what each sales rep has earned, and on what.
//
// Nigerian property sales are commission-driven, and on installment sales the
// commission is usually paid PROGRESSIVELY: a slice of each payment as it
// lands, not a lump sum at reservation. A developer who paid full commission
// the day a unit was reserved, on a buyer who then defaulted at installment 3,
// has paid out money that never arrived. So the unit of accrual here is the
// PAYMENT, not the reservation.
//
// TWO DECISIONS WORTH KNOWING:
//
// 1. The rate is COPIED onto the commission row at accrual time. Raising a
//    rep's rate must not silently rewrite what they earned last quarter.
//
// 2. `unique (payment_id)` in migrations/003 is the idempotency lock. The
//    payment path can be re-entered — a replayed Paystack webhook, a manual
//    re-record — without a rep being paid twice for the same money.

const { supabaseAdmin } = require('../middleware/orgContext');

const round2 = (value) => Math.round(Number(value) * 100) / 100;

// Called from paymentEvents after a payment lands. Never throws: a commission
// that failed to accrue is a reconcilable bookkeeping gap, while a payment
// that 500s because of one is lost money.
async function accrueForPayment({ orgId, payment, reservation, salesRep }) {
  try {
    if (!salesRep?.id) return { accrued: false, reason: 'no sales rep on the reservation' };

    const rate = Number(salesRep.commission_rate || 0);
    if (!(rate > 0)) return { accrued: false, reason: 'rep has no commission rate set' };

    const base = Number(payment.amount || 0);
    if (!(base > 0)) return { accrued: false, reason: 'payment has no amount' };

    const { data, error } = await supabaseAdmin
      .from('re_commissions')
      .insert({
        organization_id: orgId,
        sales_rep_id: salesRep.id,
        reservation_id: reservation.id,
        payment_id: payment.id,
        rate,
        base_amount: base,
        amount: round2((base * rate) / 100),
      })
      .select()
      .single();

    // 23505 = already accrued for this payment. That is the lock doing its
    // job, not an error.
    if (error?.code === '23505') return { accrued: false, reason: 'already accrued' };
    if (error) throw error;

    return { accrued: true, commission: data };
  } catch (err) {
    console.warn('[commission] accrual failed:', err.message);
    return { accrued: false, reason: err.message };
  }
}

// Per-rep totals: what they have earned, what is still owed, what has been
// paid out. This is the number an admin team currently keeps in a spreadsheet
// and reconciles by hand every month.
async function summaryByRep(orgId, { from = null, to = null } = {}) {
  let query = supabaseAdmin
    .from('re_commissions')
    .select('sales_rep_id, amount, base_amount, status, created_at, re_sales_reps(id, commission_rate, active, users(id, full_name, email))')
    .eq('organization_id', orgId);

  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);

  const { data, error } = await query;
  if (error) throw error;

  const byRep = new Map();
  for (const row of data || []) {
    const rep = row.re_sales_reps;
    const key = row.sales_rep_id;
    const entry = byRep.get(key) || {
      sales_rep_id: key,
      name: rep?.users?.full_name || rep?.users?.email || 'Unassigned',
      email: rep?.users?.email || null,
      commission_rate: Number(rep?.commission_rate || 0),
      active: rep?.active !== false,
      earned: 0,
      accrued: 0,   // earned but not yet approved for payout
      approved: 0,  // approved, not yet paid
      paid: 0,
      collected_base: 0,
      entries: 0,
    };

    const amount = Number(row.amount || 0);
    if (row.status !== 'void') {
      entry.earned += amount;
      entry.collected_base += Number(row.base_amount || 0);
      entry.entries += 1;
      if (row.status === 'paid') entry.paid += amount;
      else if (row.status === 'approved') entry.approved += amount;
      else entry.accrued += amount;
    }

    byRep.set(key, entry);
  }

  return [...byRep.values()]
    .map((entry) => ({
      ...entry,
      earned: round2(entry.earned),
      accrued: round2(entry.accrued),
      approved: round2(entry.approved),
      paid: round2(entry.paid),
      outstanding: round2(entry.accrued + entry.approved),
      collected_base: round2(entry.collected_base),
    }))
    .sort((a, b) => b.earned - a.earned);
}

// A sales director's weekly-meeting screen: who is bringing in reservations,
// whose portfolio is going bad. Everything here already existed in the data —
// it had simply never been put on a page.
async function repPerformance(orgId) {
  const [reps, reservations, commissions] = await Promise.all([
    supabaseAdmin
      .from('re_sales_reps')
      .select('id, active, commission_rate, users(id, full_name, email)')
      .eq('organization_id', orgId),
    supabaseAdmin
      .from('re_reservations')
      .select(`
        id, sales_rep_id, status, created_at,
        re_units(list_price),
        re_installment_plans(
          total_amount,
          re_installment_schedule(status, amount_due)
        )`)
      .eq('organization_id', orgId),
    supabaseAdmin
      .from('re_commissions')
      .select('sales_rep_id, amount, status')
      .eq('organization_id', orgId),
  ]);

  for (const result of [reps, reservations, commissions]) {
    if (result.error) throw result.error;
  }

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  const monthStartIso = monthStart.toISOString().slice(0, 10);

  const rows = (reps.data || []).map((rep) => {
    const mine = (reservations.data || []).filter((r) => r.sales_rep_id === rep.id);

    let overdueInstallments = 0;
    let overdueAmount = 0;
    let portfolioValue = 0;
    let collected = 0;
    const buyersAtRisk = new Set();

    for (const reservation of mine) {
      const plan = Array.isArray(reservation.re_installment_plans)
        ? reservation.re_installment_plans[0]
        : reservation.re_installment_plans;

      portfolioValue += Number(plan?.total_amount || reservation.re_units?.list_price || 0);

      const schedule = plan?.re_installment_schedule || [];
      for (const row of schedule) {
        if (row.status === 'paid') collected += Number(row.amount_due || 0);
        if (row.status === 'overdue') {
          overdueInstallments += 1;
          overdueAmount += Number(row.amount_due || 0);
          buyersAtRisk.add(reservation.id);
        }
      }
    }

    const earned = (commissions.data || [])
      .filter((c) => c.sales_rep_id === rep.id && c.status !== 'void')
      .reduce((sum, c) => sum + Number(c.amount || 0), 0);

    return {
      sales_rep_id: rep.id,
      name: rep.users?.full_name || rep.users?.email || 'Unnamed rep',
      email: rep.users?.email || null,
      active: rep.active !== false,
      commission_rate: Number(rep.commission_rate || 0),
      reservations_total: mine.length,
      reservations_this_month: mine.filter((r) => (r.created_at || '').slice(0, 10) >= monthStartIso).length,
      reservations_completed: mine.filter((r) => r.status === 'completed').length,
      reservations_cancelled: mine.filter((r) => r.status === 'cancelled').length,
      portfolio_value: round2(portfolioValue),
      collected: round2(collected),
      // The retention number: a rep who sells well and collects badly is a
      // different problem from one who does neither.
      collection_rate: portfolioValue > 0 ? Math.round((collected / portfolioValue) * 100) : 0,
      overdue_installments: overdueInstallments,
      overdue_amount: round2(overdueAmount),
      buyers_at_risk: buyersAtRisk.size,
      commission_earned: round2(earned),
    };
  });

  return rows.sort((a, b) => b.collected - a.collected);
}

module.exports = { accrueForPayment, summaryByRep, repPerformance, round2 };
