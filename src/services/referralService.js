// referralService.js — buyer referral network (SECTION 5).
//
// Every buyer already has a referral_code (migrations/024's DB default —
// same convention as every id column's gen_random_uuid()). Two things this
// file actually does:
//
//   1. linkReferral() — at creation time, if the new buyer was given someone
//      else's code, record who referred them (re_customers.referred_by_customer_id,
//      permanent) and open a re_customer_referrals row (status 'pending',
//      workflow state — see the migration's own comment on why both exist).
//
//   2. handleFirstPayment() — called from paymentEvents.onPaymentRecorded for
//      EVERY payment; it is a no-op unless this is the referred buyer's
//      FIRST one, which the 'pending' status itself gates: any payment after
//      the first sees a row that is already 'completed' and does nothing.
const { supabaseAdmin } = require('../middleware/orgContext');
const { auditSystem } = require('./auditService');
const notify = require('./notificationService');

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

// Scoped to the SAME workspace a code was issued in — two different
// developers' buyer lists are two different businesses, and a code typed
// into the wrong one should read as "not found", not silently attach a
// buyer to a stranger's referral network.
async function findByCode(orgId, code) {
  if (!code) return null;
  const { data, error } = await supabaseAdmin
    .from('re_customers')
    .select('id, full_name')
    .eq('organization_id', orgId)
    .eq('referral_code', String(code).trim().toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Called from POST /customers right after the new row is inserted. Never
// throws past this point — a typo'd or already-used code should not block
// adding a buyer, the same reasoning notificationService.js states for its
// own three rules about a side effect never failing the request that
// triggered it.
async function linkReferral(orgId, newCustomer, referralCode) {
  if (!referralCode) return null;
  try {
    const referrer = await findByCode(orgId, referralCode);
    // A code that does not resolve, or resolves to the buyer just created
    // (only possible if someone pastes the brand-new buyer's own fresh
    // code back at creation — meaningless, not an error).
    if (!referrer || referrer.id === newCustomer.id) return null;

    const { error: updateErr } = await supabaseAdmin
      .from('re_customers')
      .update({ referred_by_customer_id: referrer.id })
      .eq('id', newCustomer.id)
      .eq('organization_id', orgId);
    if (updateErr) throw updateErr;

    const { data: referralRow, error: insertErr } = await supabaseAdmin
      .from('re_customer_referrals')
      .insert({
        organization_id: orgId,
        referring_customer_id: referrer.id,
        referred_customer_id: newCustomer.id,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    return referralRow;
  } catch (err) {
    console.warn('[referral] could not link referral code:', err.message);
    return null;
  }
}

// The credit reward reduces what is actually owed by shrinking installment
// amount_due directly, earliest-due first, across every ACTIVE plan the
// referring buyer holds — and shrinks each touched plan's total_amount by
// the exact same figure, which is what keeps installmentService's "the
// schedule sums to the plan total in kobo" invariant true afterward. A row
// reduced to exactly 0 is marked 'waived' (the same status a restructure
// already uses for "no longer owed, but no money moved") rather than 'paid'
// — nothing was paid, and creditScoreService's payment-consistency ratio
// already treats 'waived' as neither on-time nor late for exactly this
// reason.
//
// Whatever the buyer has no open installment left to absorb (fully paid up,
// say) is NOT retried against older leftover balance — it is simply added to
// referral_credit_balance, a running, informational figure, for a human to
// apply by hand later. Not real money, so it is never written as a
// re_payments row — see the migration's own comment on why.
// Pure: given the buyer's open (pending/overdue) schedule rows and a credit
// amount, decides which rows shrink by how much, earliest due_date first.
// Split out from applyCreditToOutstandingBalance so this — the actual
// allocation logic — is testable without a database, the same shape as
// creditScoreService's computeFromHistory and constructionService's
// currentMilestoneSummary.
function allocateCredit(openRows, amount) {
  let remaining = round2(amount);
  const sorted = [...openRows].sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')));

  const planDeltas = new Map();
  const rowUpdates = [];
  for (const row of sorted) {
    if (remaining <= 0) break;
    const applied = Math.min(remaining, Number(row.amount_due));
    const newAmountDue = round2(Number(row.amount_due) - applied);
    rowUpdates.push({ id: row.id, plan_id: row.plan_id, amount_due: newAmountDue, status: newAmountDue <= 0 ? 'waived' : row.status });
    planDeltas.set(row.plan_id, round2((planDeltas.get(row.plan_id) || 0) + applied));
    remaining = round2(remaining - applied);
  }

  return { rowUpdates, planDeltas, applied: round2(amount - remaining), remaining };
}

async function applyCreditToOutstandingBalance(orgId, customerId, amount) {
  if (round2(amount) <= 0) return { applied: 0, remaining: 0 };

  const { data: reservations, error } = await supabaseAdmin
    .from('re_reservations')
    .select(`
      id,
      re_installment_plans(id, total_amount, status,
        re_installment_schedule(id, amount_due, status, due_date))
    `)
    .eq('organization_id', orgId)
    .eq('customer_id', customerId)
    .neq('status', 'cancelled');
  if (error) throw error;

  const openRows = [];
  const planTotals = new Map();
  for (const reservation of reservations || []) {
    for (const plan of asArray(reservation.re_installment_plans)) {
      if (plan.status !== 'active') continue;
      planTotals.set(plan.id, Number(plan.total_amount));
      for (const row of plan.re_installment_schedule || []) {
        if (row.status === 'pending' || row.status === 'overdue') {
          openRows.push({ ...row, plan_id: plan.id });
        }
      }
    }
  }

  const { rowUpdates, planDeltas, applied, remaining } = allocateCredit(openRows, amount);

  for (const update of rowUpdates) {
    const { error: rowErr } = await supabaseAdmin
      .from('re_installment_schedule')
      .update({ amount_due: update.amount_due, status: update.status })
      .eq('id', update.id);
    if (rowErr) throw rowErr;
  }
  for (const [planId, delta] of planDeltas) {
    const { error: planErr } = await supabaseAdmin
      .from('re_installment_plans')
      .update({ total_amount: round2(planTotals.get(planId) - delta) })
      .eq('id', planId);
    if (planErr) throw planErr;
  }

  return { applied, remaining };
}

async function fileCashBonusTask(orgId, { referrer, referred, amount }) {
  const { error } = await supabaseAdmin.from('re_tasks').insert({
    organization_id: orgId,
    title: `Pay ₦${amount.toLocaleString('en-NG')} referral bonus to ${referrer.full_name}`,
    notes: `${referrer.full_name} referred ${referred.full_name}, who has now made their first payment. `
      + `Pay the cash referral bonus and mark this task done once it is handed over.`,
    // System-generated, not a human-authored follow-up — same source value
    // rentalService.checkTenancyRenewals uses for its own deterministic,
    // rule-triggered tasks, not just for OpenAI-drafted ones.
    source: 'ai',
  });
  if (error) console.warn('[referral] could not file cash bonus task:', error.message);
}

async function notifyReferrer(orgId, { referrer, referred, rewardType, amount, applied, companyName }) {
  const heading = rewardType === 'credit'
    ? `You earned a ₦${amount.toLocaleString('en-NG')} referral credit`
    : rewardType === 'cash'
      ? `You earned a ₦${amount.toLocaleString('en-NG')} referral bonus`
      : 'Your referral just converted';

  const detail = rewardType === 'credit'
    ? (applied > 0
      ? `₦${applied.toLocaleString('en-NG')} has already been applied to your balance.`
      : 'It has been added to your account as credit for a future payment.')
    : rewardType === 'cash'
      ? `${companyName || 'The team'} will be in touch to arrange it.`
      : `${referred.full_name} used your referral code and just made their first payment.`;

  const message = `Hi ${referrer.full_name}, ${referred.full_name} used your referral code and made their `
    + `first payment. ${rewardType === 'none' ? '' : `You earned a ₦${amount.toLocaleString('en-NG')} `
      + `referral ${rewardType === 'credit' ? 'credit' : 'bonus'}. ${detail}`}`.trim();

  if (referrer.email) {
    await notify.sendEmail({
      orgId,
      to: referrer.email,
      subject: heading,
      html: notify.emailShell({ heading, intro: message }),
      text: message,
      template: 'referral_completed',
      relatedType: 're_customers',
      relatedId: referrer.id,
    });
  }
  if (referrer.phone) {
    await notify.sendWhatsApp({
      orgId,
      to: referrer.phone,
      body: message,
      template: 'referral_completed',
      relatedType: 're_customers',
      relatedId: referrer.id,
    });
  }
}

// Called from paymentEvents.onPaymentRecorded after every real payment.
// Never throws — a referral bonus miscalculating must not turn a recorded
// payment into a 500, the same rule paymentEvents.js's own file comment
// states for everything else it calls.
async function handleFirstPayment(orgId, customerId) {
  try {
    const { data: pendingRow, error: findErr } = await supabaseAdmin
      .from('re_customer_referrals')
      .select('id, referring_customer_id, referred_customer_id')
      .eq('organization_id', orgId)
      .eq('referred_customer_id', customerId)
      .eq('status', 'pending')
      .maybeSingle();
    if (findErr) throw findErr;
    if (!pendingRow) return null; // not a referred buyer, or already completed

    const [{ data: settings }, { data: referrer }, { data: referred }] = await Promise.all([
      supabaseAdmin.from('re_org_settings')
        .select('referral_reward_type, referral_reward_amount, company_name')
        .eq('organization_id', orgId).maybeSingle(),
      supabaseAdmin.from('re_customers')
        .select('id, full_name, email, phone, referral_credit_balance')
        .eq('id', pendingRow.referring_customer_id).maybeSingle(),
      supabaseAdmin.from('re_customers')
        .select('id, full_name')
        .eq('id', pendingRow.referred_customer_id).maybeSingle(),
    ]);
    if (!referrer || !referred) return null;

    const rewardType = settings?.referral_reward_type && settings.referral_reward_type !== 'none'
      ? settings.referral_reward_type
      : 'none';
    const amount = rewardType === 'none' ? 0 : round2(Number(settings.referral_reward_amount || 0));

    // The 'pending' filter above already narrows to one row, but a
    // concurrent second payment landing in the same instant could reach
    // this same point before either write commits — the status='pending'
    // clause here is what actually decides which one wins; the other
    // updates zero rows and returns.
    const { data: completedRow, error: completeErr } = await supabaseAdmin
      .from('re_customer_referrals')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        reward_type: rewardType === 'none' ? null : rewardType,
        reward_amount: rewardType === 'none' ? null : amount,
      })
      .eq('id', pendingRow.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    if (completeErr) throw completeErr;
    if (!completedRow) return null; // lost the race to a concurrent call

    let applied = 0;
    if (rewardType === 'credit' && amount > 0) {
      const result = await applyCreditToOutstandingBalance(orgId, referrer.id, amount);
      applied = result.applied;
      if (result.remaining > 0) {
        await supabaseAdmin.from('re_customers')
          .update({ referral_credit_balance: round2(Number(referrer.referral_credit_balance || 0) + result.remaining) })
          .eq('id', referrer.id);
      }
    } else if (rewardType === 'cash' && amount > 0) {
      await fileCashBonusTask(orgId, { referrer, referred, amount });
    }

    await auditSystem({
      orgId,
      action: 'referral.completed',
      entityType: 're_customer_referrals',
      entityId: completedRow.id,
      summary: `${referred.full_name}'s first payment completed ${referrer.full_name}'s referral`
        + (rewardType === 'none' ? '' : ` — ₦${amount.toLocaleString('en-NG')} ${rewardType} reward`),
      metadata: { reward_type: rewardType, reward_amount: amount, applied },
    });

    await notifyReferrer(orgId, {
      referrer, referred, rewardType, amount, applied, companyName: settings?.company_name,
    });

    return completedRow;
  } catch (err) {
    console.warn('[referral] could not process referral completion:', err.message);
    return null;
  }
}

async function getStats(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_customer_referrals')
    .select('status, reward_type, reward_amount')
    .eq('organization_id', orgId);
  if (error) throw error;

  const rows = data || [];
  const completed = rows.filter((r) => r.status === 'completed').length;
  const totalCreditsGiven = rows
    .filter((r) => r.reward_type === 'credit')
    .reduce((sum, r) => sum + Number(r.reward_amount || 0), 0);

  return {
    total_referrals: rows.length,
    completed_referrals: completed,
    conversion_rate: rows.length ? Math.round((completed / rows.length) * 1000) / 10 : 0,
    total_credits_given: round2(totalCreditsGiven),
  };
}

module.exports = {
  findByCode,
  linkReferral,
  allocateCredit,
  applyCreditToOutstandingBalance,
  handleFirstPayment,
  getStats,
};
