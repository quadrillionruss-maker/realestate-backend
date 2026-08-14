// contractorService.js — contractor and supplier payment tracking, SECTION 12.
//
// The mirror of the rest of this product: every other service tracks money
// coming IN from buyers; this tracks it going OUT to whoever is building the
// thing. Nothing here touches re_payments, re_installment_schedule or
// commission — a contractor payment is a developer's own outflow, entirely
// separate from a buyer's installment plan.
const { supabaseAdmin } = require('../middleware/orgContext');
const { audit, auditSystem } = require('./auditService');

const CONTRACTOR_TYPES = ['foundation', 'roofing', 'finishing', 'electrical', 'plumbing', 'landscaping', 'other'];
const PAYMENT_STATUSES = ['pending', 'paid', 'overdue'];
// How far back "current collection rate" looks, and how far forward an
// upcoming contractor payment is worth flagging — both three months, so the
// forecast compares like-for-like windows rather than a rate built from a
// year of history against a payment due next week.
const FORECAST_WINDOW_MONTHS = 3;

async function assertProjectInOrg(orgId, projectId) {
  const { data } = await supabaseAdmin
    .from('re_projects').select('id').eq('id', projectId).eq('organization_id', orgId).maybeSingle();
  return Boolean(data);
}

// ── Contractors ────────────────────────────────────────────────────────
async function listContractors(orgId, projectId) {
  const { data, error } = await supabaseAdmin
    .from('re_contractors')
    .select('*')
    .eq('organization_id', orgId)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function createContractor(req, projectId, { name, type, phone, email }) {
  if (!(await assertProjectInOrg(req.orgId, projectId))) return { notFound: true };
  if (!name) throw Object.assign(new Error('name is required'), { statusCode: 400 });
  if (!CONTRACTOR_TYPES.includes(type)) {
    throw Object.assign(new Error(`type must be one of: ${CONTRACTOR_TYPES.join(', ')}`), { statusCode: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('re_contractors')
    .insert({ organization_id: req.orgId, project_id: projectId, name, type, phone: phone || null, email: email || null })
    .select()
    .single();
  if (error) throw error;

  audit(req, {
    action: 'contractor.created',
    entityType: 're_contractors',
    entityId: data.id,
    summary: `Contractor "${data.name}" (${data.type}) added`,
    metadata: { project_id: projectId },
  });

  return data;
}

// ── Contractor payments ───────────────────────────────────────────────
async function listPayments(orgId, projectId) {
  const { data, error } = await supabaseAdmin
    .from('re_contractor_payments')
    .select('*, re_contractors(name, type)')
    .eq('organization_id', orgId)
    .eq('project_id', projectId)
    .order('due_date', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function createPayment(req, projectId, { contractorId, milestoneId, amount, dueDate, description }) {
  if (!(await assertProjectInOrg(req.orgId, projectId))) return { notFound: true };
  if (!contractorId || !dueDate) {
    throw Object.assign(new Error('contractor_id and due_date are required'), { statusCode: 400 });
  }
  if (!(Number(amount) > 0)) {
    throw Object.assign(new Error('amount must be a positive amount'), { statusCode: 400 });
  }

  const { data: contractor } = await supabaseAdmin
    .from('re_contractors').select('id').eq('id', contractorId).eq('organization_id', req.orgId).maybeSingle();
  if (!contractor) throw Object.assign(new Error('Contractor not found'), { statusCode: 404 });

  const { data, error } = await supabaseAdmin
    .from('re_contractor_payments')
    .insert({
      organization_id: req.orgId,
      contractor_id: contractorId,
      project_id: projectId,
      milestone_id: milestoneId || null,
      amount,
      due_date: dueDate,
      description: description || null,
    })
    .select('*, re_contractors(name, type)')
    .single();
  if (error) throw error;

  audit(req, {
    action: 'contractorPayment.created',
    entityType: 're_contractor_payments',
    entityId: data.id,
    summary: `${data.re_contractors?.name || 'Contractor'} payment of ₦${Number(amount).toLocaleString('en-NG')} scheduled for ${dueDate}`,
    metadata: { project_id: projectId, contractor_id: contractorId, amount, due_date: dueDate },
  });

  return data;
}

async function updatePayment(req, id, { status, paidDate, description }) {
  const patch = {};
  if (status !== undefined) {
    if (!PAYMENT_STATUSES.includes(status)) {
      throw Object.assign(new Error(`status must be one of: ${PAYMENT_STATUSES.join(', ')}`), { statusCode: 400 });
    }
    patch.status = status;
    if (status === 'paid') patch.paid_date = paidDate || new Date().toISOString().slice(0, 10);
  }
  if (paidDate !== undefined && status === undefined) patch.paid_date = paidDate || null;
  if (description !== undefined) patch.description = description || null;

  if (!Object.keys(patch).length) {
    throw Object.assign(new Error('No updatable fields provided'), { statusCode: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('re_contractor_payments')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', req.orgId)
    .select('*, re_contractors(name, type)')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { notFound: true };

  audit(req, {
    action: 'contractorPayment.updated',
    entityType: 're_contractor_payments',
    entityId: data.id,
    summary: `${data.re_contractors?.name || 'Contractor'} payment moved to ${data.status}`,
    metadata: patch,
  });

  return data;
}

// ── Cash flow forecast ────────────────────────────────────────────────
// "At current buyer collection rate, flag if an upcoming contractor payment
// cannot be covered by projected collections." A deliberately simple
// running-balance model, not a full ledger simulation: average of the
// trailing 3 months' actual collections on this project stands in for next
// month's, spent down in due-date order against every still-pending
// contractor payment. The first one that would take the balance negative is
// the one worth a developer's attention — everything after it inherits the
// same shortfall, so only the first is reported per project.
function monthsAgoIso(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function cashFlowForecast(orgId, projectId) {
  const [{ data: payments }, { data: pending }] = await Promise.all([
    supabaseAdmin
      .from('re_payments')
      .select('amount, paid_at, re_installment_schedule!inner(re_installment_plans!inner(re_reservations!inner(re_units!inner(project_id))))')
      .eq('organization_id', orgId)
      .eq('re_installment_schedule.re_installment_plans.re_reservations.re_units.project_id', projectId)
      .gte('paid_at', monthsAgoIso(FORECAST_WINDOW_MONTHS))
      .is('voided_at', null),
    supabaseAdmin
      .from('re_contractor_payments')
      .select('id, amount, due_date, description, re_contractors(name, type)')
      .eq('organization_id', orgId)
      .eq('project_id', projectId)
      .eq('status', 'pending')
      .order('due_date', { ascending: true }),
  ]);

  const collected = (payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const avgMonthlyCollection = collected / FORECAST_WINDOW_MONTHS;

  let runningBalance = avgMonthlyCollection;
  let shortfall = null;
  for (const payment of pending || []) {
    runningBalance -= Number(payment.amount || 0);
    if (runningBalance < 0 && !shortfall) {
      shortfall = {
        contractor_payment_id: payment.id,
        contractor_name: payment.re_contractors?.name || 'contractor',
        contractor_type: payment.re_contractors?.type || null,
        amount: Number(payment.amount || 0),
        due_date: payment.due_date,
        shortfall_amount: Math.round(Math.abs(runningBalance) * 100) / 100,
        message: `Projected shortfall of ₦${Math.round(Math.abs(runningBalance) / 1_000_000)}m for `
          + `${payment.re_contractors?.type || 'contractor'} payment due `
          + `${new Date(payment.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}.`,
      };
    }
  }

  return {
    avg_monthly_collection: Math.round(avgMonthlyCollection * 100) / 100,
    pending_total: Math.round((pending || []).reduce((sum, p) => sum + Number(p.amount || 0), 0) * 100) / 100,
    shortfall,
  };
}

// SECTION 12 — "When a contractor payment becomes overdue: create a task
// for the owner." Run from jobs/daily.js's morning sweep, same shape as
// every other sweep there: only ever raises pending → overdue, and only
// ever files the task at the moment it flips, so a re-run of the sweep
// (idempotency, the same reasoning markOverdue's own file states) never
// double-files it — once flipped, the row no longer matches this query.
async function sweepOverdueContractorPayments() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: overdue, error } = await supabaseAdmin
    .from('re_contractor_payments')
    .select('id, organization_id, amount, due_date, re_contractors(name)')
    .eq('status', 'pending')
    .lt('due_date', today);
  if (error) throw error;

  let flagged = 0;
  for (const payment of overdue || []) {
    const { error: updateErr } = await supabaseAdmin
      .from('re_contractor_payments').update({ status: 'overdue' }).eq('id', payment.id).eq('status', 'pending');
    if (updateErr) { console.warn('[contractors] could not mark overdue:', updateErr.message); continue; }

    flagged += 1;
    const { data: team } = await supabaseAdmin
      .from('teams').select('owner_id').eq('id', payment.organization_id).maybeSingle();
    const ownerId = team?.owner_id || payment.organization_id;

    await supabaseAdmin.from('re_tasks').insert({
      organization_id: payment.organization_id,
      title: `Overdue contractor payment — ${payment.re_contractors?.name || 'contractor'}`,
      notes: `₦${Number(payment.amount).toLocaleString('en-NG')} was due ${payment.due_date} and is unpaid.`,
      assigned_to: ownerId,
      source: 'ai',
    });

    auditSystem({
      orgId: payment.organization_id,
      action: 'contractorPayment.overdue',
      entityType: 're_contractor_payments',
      entityId: payment.id,
      summary: `${payment.re_contractors?.name || 'Contractor'} payment overdue since ${payment.due_date}`,
    });
  }

  return { flagged };
}

module.exports = {
  CONTRACTOR_TYPES, PAYMENT_STATUSES,
  listContractors, createContractor, listPayments, createPayment, updatePayment,
  cashFlowForecast, sweepOverdueContractorPayments,
};
