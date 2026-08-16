#!/usr/bin/env node
// backfill-credit-scores.js — one-off: recompute every existing buyer's
// credit_score against the current, corrected formula.
//
//   npm run backfill:credit-scores
//
// THE BUG this repairs: creditScoreService.recompute() was only ever called
// from a payment being recorded, a promise resolving, or a hardship being
// approved — never from the daily overdue sweep itself. A buyer who simply
// stopped paying (no payment, no promise, no hardship request against them)
// never triggered any of those, so credit_score sat at the re_customers
// default of 100 forever, no matter how many installments piled up overdue
// underneath it. overdueService.markOverdue now recomputes going forward;
// this script is the one-time catch-up for every buyer whose stored score
// was already stale before that fix landed.
//
// Safe to re-run: recompute() is idempotent (it always derives the score
// fresh from current history) and never throws — a single buyer's failed
// computation is logged and skipped, not fatal to the run.

const { supabaseAdmin } = require('../src/middleware/orgContext');
const { recompute } = require('../src/services/creditScoreService');
const { mapWithConcurrency } = require('../src/utils/concurrency');

const CONCURRENCY = 8;
const PAGE_SIZE = 500;

async function fetchAllCustomers() {
  const customers = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .select('id, organization_id, credit_score')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    customers.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return customers;
}

async function main() {
  console.log('[backfill] loading every buyer...');
  const customers = await fetchAllCustomers();
  console.log(`[backfill] ${customers.length} buyer(s) found. Recomputing...`);

  let changed = 0;
  let unchanged = 0;
  let failed = 0;

  await mapWithConcurrency(customers, CONCURRENCY, async (customer) => {
    const before = customer.credit_score;
    const after = await recompute(customer.organization_id, customer.id);
    if (after === null) {
      failed += 1;
      console.warn(`[backfill] could not recompute customer ${customer.id}`);
      return;
    }
    if (after !== before) {
      changed += 1;
      console.log(`[backfill] ${customer.id}: ${before} -> ${after}`);
    } else {
      unchanged += 1;
    }
  });

  console.log(`\n[backfill] done. ${changed} changed, ${unchanged} unchanged, ${failed} failed, ${customers.length} total.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[backfill] fatal:', err.message);
  process.exitCode = 1;
});
