// undoService.js — SECTION 12 (feature expansion): reversing one of the
// seven action types the product spec names as reversible.
//
// Every handler below is keyed to the EXACT action string the call site
// that marked it reversible:true actually uses (see auditService.js's own
// header) — not a generic "undo whatever this entity_type/id was" that
// would have to guess what "before" meant.
//
// payment.recorded's handler deliberately does NOT try to manually unwind
// commission accrual, the receipt, the emails, the credit score, the
// default-risk score, or contact-timing — reversing a payment means voiding
// it, and paystackService.voidPayment (plus applyPaymentsToSchedule) is the
// ALREADY-CORRECT, already-tested mechanism this product uses for exactly
// that. Re-deriving that logic here, second-hand, would be the riskier
// choice for a change to real money.
const { supabaseAdmin } = require('../middleware/orgContext');
const { voidPayment, applyPaymentsToSchedule } = require('./paystackService');
const { audit } = require('./auditService');

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

async function undoPaymentRecorded(orgId, entry) {
  const paymentId = entry.reversal_data?.payment_id || entry.entity_id;
  await voidPayment(orgId, paymentId, 'Reversed via System Log undo');
  const commissionId = entry.reversal_data?.commission_id;
  if (commissionId) {
    await supabaseAdmin
      .from('re_commissions').update({ status: 'void' })
      .eq('id', commissionId).eq('organization_id', orgId).neq('status', 'void');
  }
}

async function undoPaymentVoided(orgId, entry) {
  const { error } = await supabaseAdmin
    .from('re_payments')
    .update({ voided_at: null, void_reason: null })
    .eq('id', entry.entity_id)
    .eq('organization_id', orgId)
    .not('voided_at', 'is', null);
  if (error) throw error;

  const scheduleId = entry.reversal_data?.schedule_id;
  if (scheduleId) await applyPaymentsToSchedule(scheduleId);

  const commissionId = entry.reversal_data?.commission_id;
  if (commissionId) {
    // Restored to 'accrued', not necessarily the finer-grained status
    // (approved/paid) it held before voiding — see this file's own header
    // and payments.js's own comment on the void route for why that
    // precision is not worth chasing here.
    await supabaseAdmin
      .from('re_commissions').update({ status: 'accrued' })
      .eq('id', commissionId).eq('organization_id', orgId).eq('status', 'void');
  }
}

async function undoInstallmentWaived(orgId, entry) {
  const previousStatus = entry.reversal_data?.previous_status || 'pending';
  const { error } = await supabaseAdmin
    .from('re_installment_schedule')
    .update({ status: previousStatus })
    .eq('id', entry.entity_id)
    .eq('organization_id', orgId)
    .eq('status', 'waived');
  if (error) throw error;
}

async function undoTaskStatusChanged(orgId, entry) {
  const previousStatus = entry.reversal_data?.previous_status || 'open';
  const { error } = await supabaseAdmin
    .from('re_tasks')
    .update({ status: previousStatus })
    .eq('id', entry.entity_id)
    .eq('organization_id', orgId);
  if (error) throw error;
}

async function undoDocumentGenerated(orgId, entry) {
  const { error } = await supabaseAdmin
    .from('re_documents')
    .update({ status: 'pending', storage_path: null, generated_at: null })
    .eq('id', entry.entity_id)
    .eq('organization_id', orgId);
  if (error) throw error;
}

async function undoCustomerBlacklisted(orgId, entry) {
  const { error } = await supabaseAdmin
    .from('re_customers')
    .update({ blacklisted: false, blacklist_reason: null, blacklisted_at: null, blacklisted_by: null })
    .eq('id', entry.entity_id)
    .eq('organization_id', orgId)
    .eq('blacklisted', true);
  if (error) throw error;
}

const HANDLERS = {
  'payment.recorded': undoPaymentRecorded,
  'payment.voided': undoPaymentVoided,
  'installment.waived': undoInstallmentWaived,
  'task.status_changed': undoTaskStatusChanged,
  'document.generated': undoDocumentGenerated,
  'customer.blacklisted': undoCustomerBlacklisted,
};

async function undo(req, auditId) {
  const { data: entry, error } = await supabaseAdmin
    .from('re_audit_log')
    .select('*')
    .eq('id', auditId)
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (error) throw error;
  if (!entry) return { notFound: true };
  if (!entry.reversible) throw badRequest('This action cannot be undone.');
  if (entry.reversed_at) throw badRequest('This action has already been undone.');

  const handler = HANDLERS[entry.action];
  if (!handler) throw badRequest('This action type has no undo handler.');

  await handler(req.orgId, entry);

  const { error: markErr } = await supabaseAdmin
    .from('re_audit_log')
    .update({ reversed_at: new Date().toISOString(), reversed_by: req.userId })
    .eq('id', entry.id);
  if (markErr) throw markErr;

  audit(req, {
    action: `${entry.action}.undone`,
    entityType: entry.entity_type,
    entityId: entry.entity_id,
    summary: `Undone: ${entry.summary || entry.action}`,
    metadata: { original_audit_id: entry.id },
  });

  return { undone: true, original_action: entry.action };
}

module.exports = { undo, HANDLERS };
