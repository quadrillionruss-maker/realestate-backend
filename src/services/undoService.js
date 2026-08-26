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
const { loadPaymentContext } = require('./receiptService');

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

async function undoPaymentRecorded(orgId, entry) {
  const paymentId = entry.reversal_data?.payment_id || entry.entity_id;

  // FEATURE — outright sales. Loaded BEFORE voiding — loadPaymentContext
  // filters `voided_at is null`, so this is the last point this payment's
  // reservation/unit are still reachable through it.
  const context = await loadPaymentContext(orgId, paymentId);

  await voidPayment(orgId, paymentId, 'Reversed via System Log undo');
  const commissionId = entry.reversal_data?.commission_id;
  if (commissionId) {
    await supabaseAdmin
      .from('re_commissions').update({ status: 'void' })
      .eq('id', commissionId).eq('organization_id', orgId).neq('status', 'void');
  }

  // Voiding the payment already reverts the schedule row itself
  // (voidPayment -> applyPaymentsToSchedule), but that is the ONLY thing an
  // outright sale's completion touched that voiding also touches.
  // completeOutrightSale (paymentEvents.js) additionally moved the
  // reservation to 'completed', the unit to 'sold', and auto-generated an
  // allocation letter — none of which voidPayment knows anything about, and
  // without this a unit is left permanently unsellable against a sale the
  // ledger now says never actually happened.
  const reservation = context?.reservation;
  if (reservation && reservation.property_type === 'outright' && reservation.status === 'completed') {
    await supabaseAdmin
      .from('re_reservations')
      .update({ status: 'reserved' })
      .eq('id', reservation.id)
      .eq('organization_id', orgId)
      .eq('status', 'completed');

    if (context.unit?.id) {
      await supabaseAdmin
        .from('re_units')
        .update({ status: 'reserved' })
        .eq('id', context.unit.id)
        .eq('organization_id', orgId);
    }

    // Superseded, not deleted — "nothing is ever deleted" applies to a
    // wrongly-issued allocation letter the same as to any other row; the
    // partial unique index (one live letter per reservation) is what a new,
    // correctly-timed letter needs freed up if this sale is ever completed
    // again for real.
    await supabaseAdmin
      .from('re_documents')
      .update({ status: 'superseded', superseded_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('reservation_id', reservation.id)
      .eq('doc_type', 'allocation_letter')
      .is('superseded_at', null);
  }
}

async function undoPaymentVoided(orgId, entry) {
  const scheduleId = entry.reversal_data?.schedule_id;

  // AUDIT FIX (F4) — if a DIFFERENT, later payment has since paid this
  // installment off in full (the normal sequence: void a mistaken
  // transfer, the buyer re-sends the correct amount), restoring this old
  // payment would double-count it — the installment ends up "paid" by two
  // live payments for one debt, inflating every downstream total-paid
  // figure and potentially re-accruing a commission already earned once on
  // the replacement payment.
  if (scheduleId) {
    const { data: schedule } = await supabaseAdmin
      .from('re_installment_schedule')
      .select('status')
      .eq('id', scheduleId)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (schedule?.status === 'paid') {
      throw badRequest(
        "This installment has since been paid by a different payment — undoing this void would double-count it. Void the newer payment first if that one was the mistake."
      );
    }
  }

  const { error } = await supabaseAdmin
    .from('re_payments')
    .update({ voided_at: null, void_reason: null })
    .eq('id', entry.entity_id)
    .eq('organization_id', orgId)
    .not('voided_at', 'is', null);
  if (error) throw error;

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
  // AUDIT FIX (NF8) — only reverts if the task is still in the exact state
  // THIS action produced (routes/tasks.js now records it as
  // resulting_status); without this, undoing an old entry after a later,
  // legitimate transition (done -> dismissed) silently overwrote the newer
  // change with no trace of why. An entry written before this fix has no
  // resulting_status on file and falls back to the old, unguarded write
  // rather than becoming permanently un-undoable.
  const resultingStatus = entry.reversal_data?.resulting_status;
  let query = supabaseAdmin
    .from('re_tasks')
    .update({ status: previousStatus })
    .eq('id', entry.entity_id)
    .eq('organization_id', orgId);
  if (resultingStatus) query = query.eq('status', resultingStatus);
  const { error } = await query;
  if (error) throw error;
}

async function undoDocumentGenerated(orgId, entry) {
  // AUDIT FIX (NF8) — only reverts a document that is still 'generated';
  // without this, undoing an original document.generated entry AFTER a
  // regeneration has superseded it (documentService.writeGeneratedVersion)
  // blindly rewrote the old, already-superseded row back to 'pending' while
  // leaving superseded_at/superseded_by untouched — a self-contradictory
  // row (pending yet superseded).
  const { error } = await supabaseAdmin
    .from('re_documents')
    .update({ status: 'pending', storage_path: null, generated_at: null })
    .eq('id', entry.entity_id)
    .eq('organization_id', orgId)
    .eq('status', 'generated');
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

  // AUDIT FIX (NF9) — `.is('reversed_at', null)` plus checking a row
  // actually came back closes the race between the earlier `reversed_at`
  // check and this write: two concurrent undo requests on the same entry
  // could both pass that check before either one wrote it, producing a
  // duplicate "${action}.undone" audit row and letting whichever request
  // finished last silently overwrite who gets credited with the reversal.
  const { data: marked, error: markErr } = await supabaseAdmin
    .from('re_audit_log')
    .update({ reversed_at: new Date().toISOString(), reversed_by: req.userId })
    .eq('id', entry.id)
    .is('reversed_at', null)
    .select('id')
    .maybeSingle();
  if (markErr) throw markErr;
  if (!marked) throw badRequest('This action has already been undone.');

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
