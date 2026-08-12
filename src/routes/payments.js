const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission, isOwnRecordsOnly, salesRepIdsFor, MATCHES_NOTHING } = require('../middleware/rbac');
const { initInstallmentPayment, recordManualPayment, reallocateOverpayment, voidPayment } = require('../services/paystackService');
const { onPaymentRecorded } = require('../services/paymentEvents');
const { generateReceipt } = require('../services/receiptService');
const { getDownloadUrl } = require('../services/documentService');
const { audit } = require('../services/auditService');
const router = express.Router();

const PAYMENT_METHODS = ['paystack', 'bank_transfer', 'cash', 'pos'];
const SCHEDULE_STATUSES = ['pending', 'paid', 'overdue', 'waived'];

// Most recent first. Capped rather than paginated for v1 — a developer with
// 500 buyers reviews this month's money, not three years of it.
router.get('/', requirePermission('payments.read'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    // !inner on the chain down to re_reservations is what makes the
    // sales_rep_id filter below actually narrow the top-level rows rather
    // than being silently ignored — same requirement routes/dashboard.js's
    // identical filter already depends on.
    let query = supabaseAdmin
      .from('re_payments')
      .select('*, re_installment_schedule!inner(installment_number, due_date, amount_due, status, re_installment_plans!inner(re_reservations!inner(sales_rep_id, re_customers(full_name), re_units(unit_number, re_projects(name)))))')
      .eq('organization_id', req.orgId)
      .order('paid_at', { ascending: false })
      .limit(limit);

    // A Sales Executive sees payment STATUS for their own buyers only — the
    // permission grant (permissions.js) opens this route to sales_rep, and
    // this is the row-level half of "sees payment status, cannot record
    // payment": re_reservations.sales_rep_id references re_sales_reps(id),
    // not users(id), so the filter is the same two-step lookup used
    // everywhere else a rep's own book is scoped.
    if (isOwnRecordsOnly(req.orgRole)) {
      const repIds = await salesRepIdsFor(req);
      query = query.in(
        're_installment_schedule.re_installment_plans.re_reservations.sales_rep_id',
        repIds.length ? repIds : [MATCHES_NOTHING]
      );
    }

    if (req.query.method) query = query.eq('method', req.query.method);
    if (req.query.from) query = query.gte('paid_at', req.query.from);
    if (req.query.to) {
      // paid_at is a timestamptz. A bare "YYYY-MM-DD" is a calendar day, not
      // an instant — lte against it means <= midnight, which excludes every
      // payment made later that same day, i.e. nearly all of them. Advance to
      // the start of the next day and use lt so "to 30 Jul" actually includes
      // 30 Jul. A caller that already passed a full timestamp is trusted as-is.
      if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
        const nextDay = new Date(`${req.query.to}T00:00:00.000Z`);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        query = query.lt('paid_at', nextDay.toISOString());
      } else {
        query = query.lte('paid_at', req.query.to);
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// The installment schedule itself — what a "record a payment" screen is
// actually browsing. Before this existed, the only way to find the schedule id
// you needed was to open a customer and read it out of their nested history,
// which is why recording a payment required Postman.
router.get('/schedule', requirePermission('payments.schedule'), async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_installment_schedule')
      .select(`
        id, installment_number, due_date, amount_due, status, paid_at, plan_id,
        re_installment_plans!inner(
          id, status, reservation_id, total_amount, number_of_installments,
          re_reservations!inner(
            id, status, escalation_stage,
            re_customers(id, full_name, phone, email),
            re_units(unit_number, re_projects(id, name))
          )
        )`)
      .eq('organization_id', req.orgId)
      // A restructured reservation's OLD plan is 'superseded', not deleted —
      // its rows (some paid, some waived by the restructure) still exist and
      // would otherwise sit right alongside the new plan's rows under the
      // same reservation. Every caller of this route reasons about "what is
      // currently owed", which is exactly what the superseded plan's rows
      // are not, so they are excluded here rather than by every caller
      // separately.
      .eq('re_installment_plans.status', 'active')
      .order('due_date', { ascending: true })
      .limit(Math.min(Number(req.query.limit) || 200, 1000));

    if (req.query.status) {
      if (!SCHEDULE_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status must be one of: ${SCHEDULE_STATUSES.join(', ')}` });
      }
      query = query.eq('status', req.query.status);
    }
    if (req.query.reservation_id) {
      query = query.eq('re_installment_plans.reservation_id', req.query.reservation_id);
    }
    if (req.query.customer_id) {
      query = query.eq('re_installment_plans.re_reservations.customer_id', req.query.customer_id);
    }
    if (req.query.due_before) query = query.lte('due_date', req.query.due_before);

    // A Sales Executive browses their own buyers' schedule only — same
    // two-step re_sales_reps lookup as every other own-book filter, applied
    // here because this is the "record a payment" / "check status" screen a
    // rep is now allowed to open read-only (permissions.js: payments.schedule).
    if (isOwnRecordsOnly(req.orgRole)) {
      const repIds = await salesRepIdsFor(req);
      query = query.in(
        're_installment_plans.re_reservations.sales_rep_id',
        repIds.length ? repIds : [MATCHES_NOTHING]
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    // How much of each installment is already covered. Partial payment is
    // normal here — a buyer sends ₦400k of a ₦500k due — and a screen that
    // cannot show it invites someone to record the ₦100k balance as a full one.
    const ids = (data || []).map((row) => row.id);
    const paidBySchedule = new Map();
    if (ids.length) {
      // Chunked rather than one .in() call carrying up to this route's own
      // 1000-row limit — a single request with that many ids risks a
      // gateway or URL-length failure, which would silently make the error
      // below the ONLY thing standing between a failed lookup and every
      // installment rendering as fully outstanding (amount_paid: 0).
      const CHUNK_SIZE = 100;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const { data: payments, error: paymentsErr } = await supabaseAdmin
          .from('re_payments')
          .select('schedule_id, amount')
          .eq('organization_id', req.orgId)
          .in('schedule_id', chunk)
          .is('voided_at', null);
        // A silently swallowed error here used to mean every installment
        // rendered as fully outstanding (amount_paid: 0) — exactly the
        // condition that invites double-billing a buyer who already paid.
        if (paymentsErr) throw paymentsErr;
        for (const payment of payments || []) {
          paidBySchedule.set(
            payment.schedule_id,
            (paidBySchedule.get(payment.schedule_id) || 0) + Number(payment.amount || 0)
          );
        }
      }
    }

    res.json((data || []).map((row) => {
      const paid = paidBySchedule.get(row.id) || 0;
      return {
        ...row,
        amount_paid: paid,
        amount_outstanding: Math.max(0, Number(row.amount_due) - paid),
      };
    }));
  } catch (e) { next(e); }
});

// Paystack link for one installment, charging whatever is still outstanding.
router.post('/:scheduleId/init', requirePermission('payments.init'), async (req, res, next) => {
  try {
    const { customer_email } = req.body || {};
    if (!customer_email) return res.status(400).json({ error: 'customer_email is required' });

    // Same as routes/portal.js's own init call — without it, Paystack sends
    // the buyer to its own generic success page instead of back to their
    // portal, which is how a buyer talks themselves into paying twice on a
    // schedule row that still visually reads as unpaid.
    const env = require('../config/env');
    const callbackUrl = env.appUrl
      ? `${env.appUrl}/portal.html?paid=${encodeURIComponent(req.params.scheduleId)}`
      : null;

    const result = await initInstallmentPayment(req.orgId, req.params.scheduleId, customer_email, { callbackUrl });

    audit(req, {
      action: 'payment.initiated',
      entityType: 're_installment_schedule',
      entityId: req.params.scheduleId,
      summary: `Payment link generated for ₦${Number(result.amount).toLocaleString('en-NG')}`,
      metadata: { reference: result.reference, amount: result.amount, email: customer_email },
    });

    res.json(result);
  } catch (e) { next(e); }
});

// Offline payment: bank transfer, cash or POS. Bank transfer is how most
// Nigerian off-plan installments actually arrive, so this is not a fallback
// path — it is the common one.
router.post('/:scheduleId/record', requirePermission('payments.record'), async (req, res, next) => {
  try {
    const { amount, method, reference, payer_name } = req.body || {};
    if (amount == null) return res.status(400).json({ error: 'amount is required' });
    if (method && !PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: `method must be one of: ${PAYMENT_METHODS.join(', ')}` });
    }

    // The UI hides a waived row and a superseded plan's own rows (both are a
    // normal, common state after restructureService.restructure runs), but
    // nothing at the API stopped a payment being recorded against either —
    // the schedule_id is still a valid row in this org either way.
    const { data: target, error: targetErr } = await supabaseAdmin
      .from('re_installment_schedule')
      .select('id, status, re_installment_plans(status)')
      .eq('id', req.params.scheduleId)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (targetErr) throw targetErr;
    if (!target) return res.status(404).json({ error: 'Installment not found' });
    if (target.status === 'waived') {
      return res.status(409).json({
        error: 'This installment was waived when the plan was restructured — payment cannot be recorded against it.',
      });
    }
    if (target.re_installment_plans && target.re_installment_plans.status !== 'active') {
      return res.status(409).json({
        error: 'This installment belongs to a plan that is no longer active — payment cannot be recorded against it.',
      });
    }

    const payment = await recordManualPayment(req.orgId, req.params.scheduleId, {
      amount, method, reference, payerName: payer_name,
    });

    // Receipt, commission, buyer notification, promise resolution and the
    // audit entry — the same work a Paystack payment triggers, because which
    // door the money came through is not the buyer's concern. Awaited so the
    // response can tell the operator whether the buyer was actually emailed
    // rather than leaving them to guess.
    const effects = await onPaymentRecorded({
      orgId: req.orgId,
      paymentId: payment.id,
      source: 'manual',
      actor: req.user,
      overpayment: payment.overpayment,
    });

    res.status(201).json({ ...payment, effects });
  } catch (e) { next(e); }
});

// Moves an existing overpayment onto a different installment, without
// treating the credit as a second real-world transfer — see
// paystackService.reallocateOverpayment for why this is not just another
// call to /record.
router.post('/:paymentId/reallocate', requirePermission('payments.reallocate'), async (req, res, next) => {
  try {
    const { to_schedule_id } = req.body || {};
    if (!to_schedule_id) return res.status(400).json({ error: 'to_schedule_id is required' });

    // reallocateOverpayment only checks that both the source payment and the
    // target schedule row belong to THIS ORG — nothing stops the credit from
    // one buyer's overpaid installment being moved onto a completely
    // different buyer's schedule row (a mistyped or copy-pasted id). Checked
    // here, before any money moves, against the SAME chain the rest of the
    // product reasons about ownership through: schedule → plan → reservation.
    const [{ data: sourceChain, error: sourceErr }, { data: targetChain, error: targetErr }] = await Promise.all([
      supabaseAdmin
        .from('re_payments')
        .select('id, re_installment_schedule(re_installment_plans(reservation_id, re_reservations(customer_id)))')
        .eq('id', req.params.paymentId)
        .eq('organization_id', req.orgId)
        .maybeSingle(),
      supabaseAdmin
        .from('re_installment_schedule')
        .select('id, re_installment_plans(reservation_id, re_reservations(customer_id))')
        .eq('id', to_schedule_id)
        .eq('organization_id', req.orgId)
        .maybeSingle(),
    ]);
    if (sourceErr) throw sourceErr;
    if (targetErr) throw targetErr;
    if (!sourceChain) return res.status(404).json({ error: 'Payment not found' });
    if (!targetChain) return res.status(404).json({ error: 'Installment not found' });

    const sourceCustomerId = sourceChain.re_installment_schedule?.re_installment_plans?.re_reservations?.customer_id;
    const targetCustomerId = targetChain.re_installment_plans?.re_reservations?.customer_id;
    if (!sourceCustomerId || !targetCustomerId || sourceCustomerId !== targetCustomerId) {
      return res.status(409).json({
        error: 'This credit and the target installment belong to different buyers — reallocation refused.',
      });
    }

    const payment = await reallocateOverpayment(req.orgId, req.params.paymentId, to_schedule_id);

    // Same post-payment work as any other payment — a receipt and a buyer
    // notification are still correct here (the buyer should know their
    // credit was applied). Commission is not: commissionService recognizes
    // reallocated_from_payment_id and skips accrual on its own.
    const effects = await onPaymentRecorded({
      orgId: req.orgId,
      paymentId: payment.id,
      source: 'manual',
      actor: req.user,
      overpayment: payment.overpayment,
    });

    res.status(201).json({ ...payment, effects });
  } catch (e) { next(e); }
});

// Correcting a payment entered with the wrong amount — not a delete, and not
// an edit of the original row (see paystackService.voidPayment for why): the
// mistake stays visible, it just stops counting. Owner/Sales Director-gated
// for the same reason voiding stays at that tier and not collections': this
// is a direct, unilateral change to what a buyer is recorded as owing.
router.post('/:paymentId/void', requirePermission('payments.void'), async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required.' });

    const payment = await voidPayment(req.orgId, req.params.paymentId, reason);

    // The commission this payment earned, if any, was money that turns out
    // never to have arrived — void it too, rather than leaving a rep paid
    // (or owed) on a transfer that didn't happen.
    const { data: commission, error: commissionErr } = await supabaseAdmin
      .from('re_commissions')
      .update({ status: 'void' })
      .eq('payment_id', payment.id)
      .eq('organization_id', req.orgId)
      .neq('status', 'void')
      .select('id, amount')
      .maybeSingle();

    let commissionVoidFailed = false;
    if (commissionErr) {
      // The payment itself is already voided at this point — that must not
      // be undone by a commission-side failure, but silently reporting
      // success when the commission is still live would leave a rep paid
      // (or owed) on a transfer that turns out never to have happened.
      // Re-verify what actually happened rather than trusting the failed
      // update's absent row.
      console.error('[payments] failed to void the commission for voided payment', payment.id, ':', commissionErr.message);
      const { data: stillLive } = await supabaseAdmin
        .from('re_commissions')
        .select('id, amount')
        .eq('payment_id', payment.id)
        .eq('organization_id', req.orgId)
        .neq('status', 'void')
        .maybeSingle();
      if (stillLive) commissionVoidFailed = true;
    }

    // A receipt already handed out for this payment must stop being served —
    // a real receipt number and amount for money now explicitly recorded as
    // never having arrived. re_documents.status has no 'voided'/'superseded'
    // value in its check constraint (pending|generated|sent|signed), and
    // adding one is a migration, out of scope for this fix — so this reuses
    // 'pending' (the same value a not-yet-generated document carries) and
    // clears storage_path: portalService.js only shows a buyer documents
    // where status='generated', and documentService.getDownloadUrl gates a
    // download on storage_path being set, so both are covered without a
    // schema change.
    const { data: staleReceipt, error: receiptErr } = await supabaseAdmin
      .from('re_documents')
      .update({ status: 'pending', storage_path: null, generated_at: null })
      .eq('organization_id', req.orgId)
      .eq('payment_id', payment.id)
      .eq('doc_type', 'receipt')
      .eq('status', 'generated')
      .select('id')
      .maybeSingle();
    if (receiptErr) {
      console.error('[payments] failed to supersede the receipt for voided payment', payment.id, ':', receiptErr.message);
    }

    audit(req, {
      action: 'payment.voided',
      entityType: 're_payments',
      entityId: payment.id,
      summary: `₦${Number(payment.amount).toLocaleString('en-NG')} payment voided — ${reason}`
        + (commission ? `; commission of ₦${Number(commission.amount).toLocaleString('en-NG')} voided with it` : '')
        + (commissionVoidFailed ? '; WARNING: commission void FAILED — still live, needs manual review' : '')
        + (staleReceipt ? '; its receipt was superseded' : ''),
      metadata: {
        reason, amount: payment.amount, schedule_id: payment.schedule_id,
        commission_voided: commission?.id || null,
        commission_void_failed: commissionVoidFailed,
        receipt_superseded: staleReceipt?.id || null,
      },
    });

    res.json({
      ...payment,
      commission_voided: Boolean(commission),
      commission_void_failed: commissionVoidFailed,
      receipt_superseded: Boolean(staleReceipt),
    });
  } catch (e) { next(e); }
});

// Writing off an installment the developer has decided not to collect — a
// goodwill gesture, a dispute settled another way, a bad debt finally
// accepted. Requires a reason: unlike a payment, there is no receipt behind
// this to explain later why the money stopped being owed. Owner only — even
// a Sales Director cannot write off debt.
router.patch('/:scheduleId/waive', requirePermission('payments.waive'), async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required.' });

    const { data: schedule, error: findErr } = await supabaseAdmin
      .from('re_installment_schedule')
      .select('id, status, amount_due, installment_number')
      .eq('id', req.params.scheduleId)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!schedule) return res.status(404).json({ error: 'Installment not found' });
    if (schedule.status === 'paid') {
      return res.status(409).json({ error: 'This installment is already paid — nothing to waive.' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_installment_schedule')
      .update({ status: 'waived' })
      .eq('id', req.params.scheduleId)
      .eq('organization_id', req.orgId)
      .select()
      .single();
    if (error) throw error;

    audit(req, {
      action: 'installment.waived',
      entityType: 're_installment_schedule',
      entityId: req.params.scheduleId,
      summary: `Installment ${schedule.installment_number} (₦${Number(schedule.amount_due).toLocaleString('en-NG')}) waived — ${reason}`,
      metadata: { reason, amount_due: schedule.amount_due, was_status: schedule.status },
    });

    res.json(data);
  } catch (e) { next(e); }
});

// Re-render a receipt. Idempotent — it writes back to the same document row,
// each render at its own versioned storage path — so this doubles as "the
// buyer lost it, send it again" without producing a second receipt for one
// payment, and without the earlier render's exact bytes being lost.
router.post('/:id/receipt', requirePermission('payments.receipt'), async (req, res, next) => {
  try {
    const result = await generateReceipt(req.orgId, req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Payment not found' });

    audit(req, {
      action: result.was_regeneration ? 'receipt.regenerated' : 'receipt.generated',
      entityType: 're_payments',
      entityId: req.params.id,
      summary: `Receipt ${result.receipt_number} ${result.was_regeneration ? 'regenerated' : 'generated'}`,
      metadata: {
        document_id: result.document.id,
        previous_storage_path: result.previous_storage_path || undefined,
      },
    });

    res.json({
      document: result.document,
      download_url: result.download_url,
      receipt_number: result.receipt_number,
    });
  } catch (e) { next(e); }
});

router.get('/:id/receipt', requirePermission('payments.receipt'), async (req, res, next) => {
  try {
    const { data: doc } = await supabaseAdmin
      .from('re_documents')
      .select('id, status')
      .eq('organization_id', req.orgId)
      .eq('payment_id', req.params.id)
      .eq('doc_type', 'receipt')
      .maybeSingle();

    if (!doc) return res.status(404).json({ error: 'No receipt has been generated for this payment yet.' });

    const result = await getDownloadUrl(req.orgId, doc.id);
    if (result.notGenerated) return res.status(409).json({ error: 'That receipt is still being generated.' });
    res.json({ ...result, document_id: doc.id });
  } catch (e) { next(e); }
});

module.exports = router;
