// promiseService.js — "I'll transfer on Friday", written down.
//
// This is the most ordinary feature in the product and one of the most
// valuable. A rep calls an overdue buyer; the buyer names a date. Today that
// answer lives in the rep's head or in a WhatsApp thread with their manager,
// and by the following Tuesday nobody remembers it. The follow-up does not
// happen, and the developer finds out a month later.
//
// A promise is a row with a date on it. That is enough for the morning sweep
// to notice that Friday came and went, and for the brief to say the thing that
// actually changes behaviour: not "Mrs Adeyemi is overdue" but "Mrs Adeyemi
// promised to pay by the 15th and hasn't — that is now three days past her own
// date, on top of two missed installments."
//
// One open promise per installment (unique partial index in migrations/003).
// A second call producing a new date supersedes the first rather than stacking
// — which is exactly what "he keeps promising" means operationally, and the
// count of superseded promises is the number worth looking at.

const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday } = require('./overdueService');
const { auditSystem } = require('./auditService');

const SELECT = `
  id, promised_date, promised_amount, spoke_to, notes, status, resolved_at, created_at,
  re_installment_schedule(
    id, installment_number, due_date, amount_due, status,
    re_installment_plans(
      re_reservations(
        id,
        re_customers(id, full_name, phone, email),
        re_units(unit_number, re_projects(name))
      )
    )
  ),
  users:logged_by(full_name, email)`;

async function listPromises(orgId, { status = null, scheduleId = null, customerId = null } = {}) {
  let query = supabaseAdmin
    .from('re_payment_promises')
    .select(SELECT)
    .eq('organization_id', orgId)
    .order('promised_date', { ascending: true });

  if (status) query = query.eq('status', status);
  if (scheduleId) query = query.eq('schedule_id', scheduleId);
  if (customerId) query = query.eq('customer_id', customerId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Supersedes any promise already open on the same installment, so the row that
// remains is always the buyer's latest word.
async function logPromise(orgId, { scheduleId, promisedDate, promisedAmount, spokeTo, notes, loggedBy }) {
  if (!scheduleId) throw badRequest('schedule_id is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(promisedDate || ''))) {
    throw badRequest('promised_date must be YYYY-MM-DD');
  }

  const { data: schedule } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, re_installment_plans(re_reservations(customer_id))')
    .eq('id', scheduleId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!schedule) throw Object.assign(new Error('Installment not found'), { statusCode: 404 });

  const customerId = schedule.re_installment_plans?.re_reservations?.customer_id || null;

  const { data: superseded } = await supabaseAdmin
    .from('re_payment_promises')
    .update({ status: 'cancelled', resolved_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('schedule_id', scheduleId)
    .eq('status', 'open')
    .select('id');

  const { data, error } = await supabaseAdmin
    .from('re_payment_promises')
    .insert({
      organization_id: orgId,
      schedule_id: scheduleId,
      customer_id: customerId,
      promised_date: promisedDate,
      promised_amount: promisedAmount ?? null,
      spoke_to: spokeTo || null,
      notes: notes || null,
      logged_by: loggedBy || null,
    })
    .select(SELECT)
    .single();
  if (error) throw error;

  return { promise: data, superseded: superseded?.length || 0 };
}

async function resolvePromise(orgId, promiseId, status) {
  if (!['kept', 'broken', 'cancelled'].includes(status)) {
    throw badRequest('status must be kept, broken or cancelled');
  }

  const { data, error } = await supabaseAdmin
    .from('re_payment_promises')
    .update({ status, resolved_at: new Date().toISOString() })
    .eq('id', promiseId)
    .eq('organization_id', orgId)
    .select(SELECT)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Run every morning before the brief. A promise whose date has passed with the
// installment still unpaid is broken — and a broken promise is a stronger
// signal than an overdue date, because the buyer chose the date themselves.
async function sweepBrokenPromises(orgId = null) {
  const today = lagosToday();

  let query = supabaseAdmin
    .from('re_payment_promises')
    .select('id, organization_id, schedule_id, promised_date, customer_id, re_installment_schedule(status)')
    .eq('status', 'open')
    .lt('promised_date', today);
  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query;
  if (error) throw error;

  // A promise on an installment that has since been paid is kept, not broken,
  // even if the payment path never saw the promise (a payment recorded against
  // a different installment, a manual status change).
  const broken = [];
  const kept = [];
  for (const row of data || []) {
    (row.re_installment_schedule?.status === 'paid' ? kept : broken).push(row);
  }

  const now = new Date().toISOString();

  if (kept.length) {
    await supabaseAdmin
      .from('re_payment_promises')
      .update({ status: 'kept', resolved_at: now })
      .in('id', kept.map((row) => row.id));
  }

  if (broken.length) {
    await supabaseAdmin
      .from('re_payment_promises')
      .update({ status: 'broken', resolved_at: now })
      .in('id', broken.map((row) => row.id));

    for (const row of broken) {
      await auditSystem({
        orgId: row.organization_id,
        actorKind: 'system',
        action: 'promise.broken',
        entityType: 're_payment_promises',
        entityId: row.id,
        summary: `Promise to pay by ${row.promised_date} was not kept`,
        metadata: { schedule_id: row.schedule_id, promised_date: row.promised_date },
      });
    }
  }

  return { broken: broken.length, kept: kept.length };
}

// Fed to the brief so the AI can say "promised the 15th, still nothing"
// instead of repeating a due date the buyer has already acknowledged.
async function openAndBrokenForBrief(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_payment_promises')
    .select(`
      promised_date, promised_amount, status, spoke_to,
      re_installment_schedule(installment_number, amount_due,
        re_installment_plans(re_reservations(re_customers(full_name))))`)
    .eq('organization_id', orgId)
    .in('status', ['open', 'broken'])
    .order('promised_date', { ascending: true })
    .limit(40);
  if (error) throw error;

  return (data || []).map((row) => ({
    customer_name: row.re_installment_schedule?.re_installment_plans
      ?.re_reservations?.re_customers?.full_name || 'Unknown buyer',
    promised_date: row.promised_date,
    promised_amount: row.promised_amount != null
      ? Number(row.promised_amount)
      : Number(row.re_installment_schedule?.amount_due || 0),
    status: row.status,
    spoke_to: row.spoke_to || null,
  }));
}

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

module.exports = {
  listPromises,
  logPromise,
  resolvePromise,
  sweepBrokenPromises,
  openAndBrokenForBrief,
};
