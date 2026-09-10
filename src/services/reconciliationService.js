// reconciliationService.js — PROMPT 7, Financial Reconciliation. Matches
// Archta's own payment ledger against what actually settled somewhere else:
// Paystack's own transaction list (runPaystackReconciliation, by
// paystack_reference) or a manually uploaded bank statement CSV
// (runBankTransferReconciliation, by amount + date, since a raw bank
// statement carries no reference Archta ever generated). See
// migrations/091_reconciliation.sql's own header for the two tables' shape
// and why organization_id is duplicated onto the child table.
//
// Every query here filters organization_id explicitly, same as everywhere
// else in this product (CLAUDE.md's "Org scoping") — this file has no
// special exemption just because it reads from an external provider too.
const { supabaseAdmin } = require('../middleware/orgContext');
const { resolvePaystackSecretKey, isRealEstateReference } = require('./paystackService');
const { parseCsvToObjects, parseAmount, parseDate } = require('../utils/csv');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
// Two amounts already rounded to kobo differ only by floating-point noise
// below this — anything at or above one kobo is a real discrepancy.
const centsEqual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

const MAX_CSV_ROWS = 1000; // matches routes/imports.js's own MAX_ROWS
const BANK_TRANSFER_MATCH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // spec: "within a 2-day window"
const MAX_PAYSTACK_PAGES = 20; // 20 * 100/page = 2,000 transactions — generous for one reconciliation period

// ── Paystack ────────────────────────────────────────────────────────────
// Paginates Paystack's own transaction list for the period, keeping only
// REINST- namespaced references — the same isRealEstateReference() gate
// handleRealEstateCharge itself uses, since a workspace's Paystack account
// can be shared with another product entirely (paystackService.js's own
// header).
async function fetchPaystackTransactions(secretKey, periodStart, periodEnd) {
  const results = [];
  let page = 1;
  for (;;) {
    const url = `https://api.paystack.co/transaction?perPage=100&page=${page}&status=success`
      + `&from=${encodeURIComponent(periodStart)}&to=${encodeURIComponent(periodEnd)}`;
    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${secretKey}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error('Paystack is not responding right now. Try again shortly.');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Paystack ${response.status}: ${detail.slice(0, 200)}`);
    }
    const json = await response.json();
    const pageRows = json.data || [];
    for (const txn of pageRows) {
      if (!isRealEstateReference(txn.reference)) continue;
      results.push({ reference: txn.reference, amount: round2(Number(txn.amount) / 100), paid_at: txn.paid_at });
    }
    const total = Number(json.meta?.total || 0);
    if (pageRows.length === 0 || page * 100 >= total || page >= MAX_PAYSTACK_PAGES) break;
    page += 1;
  }
  return results;
}

// Exact-reference matching. archtaRows: [{id, amount, paystack_reference}].
// providerRows: [{reference, amount}]. Every Archta row is visited first
// (so an Archta payment with no Paystack match is never silently skipped),
// then every provider transaction not already claimed becomes its own
// unmatched item — a transaction Paystack settled that Archta never
// recorded at all, the discrepancy most worth surfacing.
function matchByReference(archtaRows, providerRows) {
  const providerByRef = new Map(providerRows.map((t) => [t.reference, t]));
  const claimedRefs = new Set();
  const items = [];

  for (const payment of archtaRows) {
    const txn = providerByRef.get(payment.paystack_reference);
    if (!txn) {
      items.push({
        payment_id: payment.id, provider_reference: payment.paystack_reference,
        archta_amount: payment.amount, provider_amount: null, status: 'unmatched',
        notes: 'No matching Paystack transaction found for this reference in the given period.',
      });
      continue;
    }
    claimedRefs.add(txn.reference);
    if (centsEqual(payment.amount, txn.amount)) {
      items.push({
        payment_id: payment.id, provider_reference: txn.reference,
        archta_amount: payment.amount, provider_amount: txn.amount, status: 'matched', notes: null,
      });
    } else {
      items.push({
        payment_id: payment.id, provider_reference: txn.reference,
        archta_amount: payment.amount, provider_amount: txn.amount, status: 'mismatched',
        notes: `Archta recorded ₦${payment.amount.toLocaleString('en-NG')} but Paystack settled ₦${txn.amount.toLocaleString('en-NG')}.`,
      });
    }
  }

  for (const txn of providerRows) {
    if (claimedRefs.has(txn.reference)) continue;
    items.push({
      payment_id: null, provider_reference: txn.reference,
      archta_amount: null, provider_amount: txn.amount, status: 'unmatched',
      notes: 'Paystack has a successful transaction with this reference but Archta has no matching payment recorded.',
    });
  }

  return items;
}

async function runPaystackReconciliation(orgId, { periodStart, periodEnd }) {
  const secretKey = await resolvePaystackSecretKey(orgId);
  if (!secretKey) {
    throw Object.assign(new Error('No Paystack key configured for this workspace or the platform.'), { statusCode: 503 });
  }

  const periodEndExclusive = new Date(Date.parse(`${periodEnd}T00:00:00Z`) + 86_400_000).toISOString();
  const [{ data: archtaPayments, error }, providerTxns] = await Promise.all([
    supabaseAdmin.from('re_payments')
      .select('id, amount, paystack_reference, paid_at')
      .eq('organization_id', orgId)
      .eq('method', 'paystack')
      .not('paystack_reference', 'is', null)
      .is('voided_at', null)
      .gte('paid_at', `${periodStart}T00:00:00Z`)
      .lt('paid_at', periodEndExclusive),
    fetchPaystackTransactions(secretKey, periodStart, periodEnd),
  ]);
  if (error) throw error;

  const items = matchByReference(archtaPayments || [], providerTxns);
  const archtaTotal = (archtaPayments || []).reduce((s, p) => s + Number(p.amount), 0);
  const providerTotal = providerTxns.reduce((s, t) => s + t.amount, 0);

  return persistRun({ orgId, provider: 'paystack', periodStart, periodEnd, archtaTotal, providerTotal, items });
}

// ── Bank transfer (manual CSV) ─────────────────────────────────────────────
// Amount + date matching, greedy-closest rather than a true optimal
// assignment: for realistic statement sizes (tens to low hundreds of rows)
// two transfers of the exact same amount landing within 2 days of each
// other is rare enough that a full bipartite-matching solver would be
// solving a problem that basically does not occur, in exchange for a lot
// more code. Each Archta payment can only be claimed once, so one payment
// is never matched to two different statement rows.
function matchByAmountAndDate(archtaRows, csvRows) {
  const pool = archtaRows.map((p) => ({ ...p, claimed: false }));
  const items = [];

  for (const csvRow of csvRows) {
    const csvTime = Date.parse(`${csvRow.date}T00:00:00Z`);
    let best = null;
    let bestDiff = Infinity;
    for (const payment of pool) {
      if (payment.claimed || !centsEqual(payment.amount, csvRow.amount)) continue;
      const diff = Math.abs(Date.parse(payment.paid_at) - csvTime);
      if (diff <= BANK_TRANSFER_MATCH_WINDOW_MS && diff < bestDiff) { best = payment; bestDiff = diff; }
    }
    if (best) {
      best.claimed = true;
      items.push({
        payment_id: best.id, provider_reference: csvRow.reference,
        archta_amount: best.amount, provider_amount: csvRow.amount, status: 'matched', notes: null,
      });
    } else {
      items.push({
        payment_id: null, provider_reference: csvRow.reference,
        archta_amount: null, provider_amount: csvRow.amount, status: 'unmatched',
        notes: `No Archta bank-transfer payment of ₦${csvRow.amount.toLocaleString('en-NG')} found within 2 days of ${csvRow.date}.`,
      });
    }
  }

  for (const payment of pool) {
    if (payment.claimed) continue;
    items.push({
      payment_id: payment.id, provider_reference: null,
      archta_amount: payment.amount, provider_amount: null, status: 'unmatched',
      notes: 'No matching row found in the uploaded bank statement.',
    });
  }

  return items;
}

async function runBankTransferReconciliation(orgId, csvText) {
  const { records } = parseCsvToObjects(csvText);
  if (!records.length) throw Object.assign(new Error('The file has no data rows.'), { statusCode: 400 });
  if (records.length > MAX_CSV_ROWS) {
    throw Object.assign(new Error(`Too many rows (${records.length}). Split the file into batches of ${MAX_CSV_ROWS}.`), { statusCode: 400 });
  }

  const csvRows = [];
  const rowErrors = [];
  for (const record of records) {
    const amount = parseAmount(record.amount);
    const date = parseDate(record.date);
    if (amount == null || amount <= 0) { rowErrors.push({ row: record.__row, error: 'amount must be a positive number' }); continue; }
    if (!date) { rowErrors.push({ row: record.__row, error: 'date is required and must be a recognisable date' }); continue; }
    csvRows.push({ reference: record.reference || null, amount, date });
  }
  if (!csvRows.length) {
    throw Object.assign(new Error('No valid rows to reconcile.'), { statusCode: 400, rowErrors });
  }

  const dates = csvRows.map((r) => r.date).sort();
  const periodStart = dates[0];
  const periodEnd = dates[dates.length - 1];
  // Widened by the match window on each side, so a statement row near the
  // edge of the file's own date range can still match an Archta payment
  // recorded just outside it.
  const lookupStart = new Date(Date.parse(`${periodStart}T00:00:00Z`) - BANK_TRANSFER_MATCH_WINDOW_MS).toISOString();
  const lookupEnd = new Date(Date.parse(`${periodEnd}T00:00:00Z`) + 86_400_000 + BANK_TRANSFER_MATCH_WINDOW_MS).toISOString();

  const { data: archtaPayments, error } = await supabaseAdmin
    .from('re_payments')
    .select('id, amount, paid_at')
    .eq('organization_id', orgId)
    .eq('method', 'bank_transfer')
    .is('voided_at', null)
    .gte('paid_at', lookupStart)
    .lt('paid_at', lookupEnd);
  if (error) throw error;

  const items = matchByAmountAndDate(archtaPayments || [], csvRows);
  const archtaTotal = (archtaPayments || []).reduce((s, p) => s + Number(p.amount), 0);
  const providerTotal = csvRows.reduce((s, r) => s + r.amount, 0);

  const run = await persistRun({ orgId, provider: 'bank_transfer', periodStart, periodEnd, archtaTotal, providerTotal, items });
  return { ...run, row_errors: rowErrors };
}

// ── Shared: persist + read back ────────────────────────────────────────────
function summarize(items) {
  const matchedCount = items.filter((i) => i.status === 'matched').length;
  const unmatchedCount = items.length - matchedCount;
  return { matchedCount, unmatchedCount, status: unmatchedCount === 0 ? 'clean' : 'discrepancies' };
}

async function persistRun({ orgId, provider, periodStart, periodEnd, archtaTotal, providerTotal, items }) {
  const { matchedCount, unmatchedCount, status } = summarize(items);

  const { data: run, error: runError } = await supabaseAdmin
    .from('re_reconciliation_runs')
    .insert({
      organization_id: orgId, provider, period_start: periodStart, period_end: periodEnd,
      archta_total: round2(archtaTotal), provider_total: round2(providerTotal),
      matched_count: matchedCount, unmatched_count: unmatchedCount, status,
    })
    .select()
    .single();
  if (runError) throw runError;

  if (items.length) {
    const { error: itemsError } = await supabaseAdmin.from('re_reconciliation_items').insert(
      items.map((item) => ({ ...item, organization_id: orgId, reconciliation_run_id: run.id }))
    );
    if (itemsError) throw itemsError;
  }

  return { ...run, items };
}

async function listRuns(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_reconciliation_runs')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

async function getRun(orgId, runId) {
  const { data: run, error: runError } = await supabaseAdmin
    .from('re_reconciliation_runs')
    .select('*')
    .eq('id', runId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (runError) throw runError;
  if (!run) return null;

  const { data: items, error: itemsError } = await supabaseAdmin
    .from('re_reconciliation_items')
    .select('*')
    .eq('reconciliation_run_id', runId)
    .eq('organization_id', orgId)
    .order('status', { ascending: true });
  if (itemsError) throw itemsError;

  return { ...run, items: items || [] };
}

module.exports = {
  runPaystackReconciliation,
  runBankTransferReconciliation,
  listRuns,
  getRun,
  // Exported for logic.test.js — pure, no database, directly unit-testable.
  matchByReference,
  matchByAmountAndDate,
  summarize,
};
