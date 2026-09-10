// aiEvaluationService.js — the AI Evaluation System: does Archta
// Intelligence give CORRECT answers, not just answers. routes/admin.js's
// GET /ai-evaluation runs every case in tests/ai-evaluation/cases.js against
// a small, deterministic, synthetic workspace this file owns entirely, and
// reports pass/fail per case with the actual answer produced.
//
// ── The eval workspace is a reserved sentinel organization_id, not a real
// one ─────────────────────────────────────────────────────────────────────
// EVAL_ORG_ID below is a fixed, obviously-synthetic UUID (never produced by
// gen_random_uuid(), which backs every real user/team id) — no `users` or
// `team_members` row ever points at it, so it never appears in
// adminService.listWorkspaces() (built entirely from those two tables) and
// nobody could sign in to it even if they tried. It exists solely so
// aiAssistantService's own org-scoped queries (organization_id carries no
// foreign key — see CLAUDE.md's "Org scoping") have a real, isolated id to
// read data back from.
//
// ── Re-seeded on every run, not created once ────────────────────────────
// seedEvalWorkspace() hard-deletes and rebuilds the whole fixture at the
// start of every evaluation, via supabaseRaw (the unfiltered client —
// normally softDelete.js's own restore-cascade is its only legitimate
// caller, per CLAUDE.md's "Nothing is ever deleted"). That rule protects
// real buyer and business data from ever vanishing; it was never about a
// synthetic fixture this file alone owns and fully controls under a
// reserved id no real workspace can ever collide with. Re-seeding fresh
// every run — rather than seeding once and leaving it — is what keeps
// "this month" vs "last month" actually true across a month boundary
// without hand maintenance, since the fixture's dates are computed from
// lagosToday() at request time, the same clock aiAssistantService itself
// reads from.
//
// ── A GET route with a side effect, on purpose ──────────────────────────
// The route this drives is a GET (per the commissioning spec), and it does
// write rows — but only ever to the reserved eval org above, never to any
// real workspace's data, so the usual "GET must not mutate" concern doesn't
// apply here the way it would anywhere else in this API. The frontend gates
// it behind an explicit "Run AI evaluation" button (admin.js's Health tab)
// rather than firing it on every tab load — each run costs real OpenAI
// calls, and an admin opening the Health tab to check a cron job has no
// reason to also burn that budget.
//
// ── Context is rebuilt here, not read back from askAssistant() ──────────
// required_data_keys checks the context object the model actually saw, but
// askAssistant() (aiAssistantService.js) does not return it — it returns
// the finished answer, deliberately, since that's the only thing its real
// caller (routes/ai.js's POST /ask) ever needs. Rather than growing that
// function's return shape for this admin-only need, evaluateCase() below
// calls the exact same exported pieces askAssistant() itself composes
// (gatherBaseContext, gatherCategoryContext, findMentionedProjectSummaries)
// in the same order, then separately calls askAssistant() for the real
// answer. Against this fixture's fully static, single-writer data the two
// gathers are always identical — the small duplicated read cost is a fair
// trade for leaving the production answer path untouched.
//
// ── No persisted run history ─────────────────────────────────────────────
// The spec asks for pass/fail per case with the actual answer, returned by
// the route — not a trend over time. Adding a table to store every run
// would be reaching for a feature nobody asked for; if "accuracy over time"
// is ever wanted, that's a new, deliberate ask, not a default.
//
// ── Not part of `npm test` ───────────────────────────────────────────────
// This hits a real database and, unless OPENAI_API_KEY is unset, a real
// OpenAI account — exactly what CLAUDE.md's Testing section says `npm test`
// itself must never do. Only the two pure helpers below (missingRequiredKeys,
// findForbiddenClaims) are unit-tested, in src/test/logic.test.js.
const crypto = require('crypto');
const { supabaseRaw } = require('../middleware/orgContext');
const { lagosToday } = require('./overdueService');
const assistant = require('./aiAssistantService');
const projectSummaries = require('./projectSummaryService');
const CASES = require('../../tests/ai-evaluation/cases');

const EVAL_ORG_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

async function must(promise) {
  const { error } = await promise;
  if (error) throw error;
}

async function clearEvalWorkspace() {
  // Dependency order matters: re_reservations.unit_id/customer_id are both
  // `on delete restrict`, so units/customers can only be removed once every
  // reservation referencing them is gone. Deleting re_reservations first
  // cascades away its own plans, schedule and payments automatically
  // (all `on delete cascade`); deleting re_projects last cascades away any
  // remaining units the same way.
  await must(supabaseRaw.from('re_reservations').delete().eq('organization_id', EVAL_ORG_ID));
  await must(supabaseRaw.from('re_project_summaries').delete().eq('organization_id', EVAL_ORG_ID));
  await must(supabaseRaw.from('re_customers').delete().eq('organization_id', EVAL_ORG_ID));
  await must(supabaseRaw.from('re_projects').delete().eq('organization_id', EVAL_ORG_ID));
}

// Builds a small, deterministic dataset covering every evaluation case at
// once: two active projects with a clear leader in this month's collections
// (Eval Gardens Phase 1 > Eval Heights), a decline from last month (Eval
// Buyer Charlie's larger payment fell in the prior month), one buyer who is
// both overdue and the highest default risk (Eval Buyer Bravo), and one
// archived project with a pre-written institutional-memory summary (Eval
// Riverside). See tests/ai-evaluation/cases.js's own header for how each
// question maps back to these rows.
async function seedEvalWorkspace() {
  await clearEvalWorkspace();

  const today = lagosToday();
  const thisMonthStart = `${today.slice(0, 7)}-01`;
  const lastMonthDate = new Date(`${thisMonthStart}T00:00:00Z`);
  lastMonthDate.setUTCMonth(lastMonthDate.getUTCMonth() - 1);
  const lastMonthStart = lastMonthDate.toISOString().slice(0, 10);
  // Always a few days inside last month, regardless of how short that month
  // was or how early in the current month this runs.
  const lastMonthPayDate = new Date(Date.parse(lastMonthStart) + 2 * 86_400_000).toISOString().slice(0, 10);
  const overdueDate = new Date(Date.parse(today) - 10 * 86_400_000).toISOString().slice(0, 10);

  const ids = {
    projectA: crypto.randomUUID(), projectB: crypto.randomUUID(), projectC: crypto.randomUUID(),
    unitA1: crypto.randomUUID(), unitA2: crypto.randomUUID(), unitB1: crypto.randomUUID(),
    customerAlpha: crypto.randomUUID(), customerBravo: crypto.randomUUID(), customerCharlie: crypto.randomUUID(),
    resAlpha: crypto.randomUUID(), resBravo: crypto.randomUUID(), resCharlie: crypto.randomUUID(),
    planAlpha: crypto.randomUUID(), planBravo: crypto.randomUUID(), planCharlie: crypto.randomUUID(),
    schedAlpha: crypto.randomUUID(), schedBravoPaid: crypto.randomUUID(), schedBravoOverdue: crypto.randomUUID(), schedCharlie: crypto.randomUUID(),
  };

  await must(supabaseRaw.from('re_projects').insert([
    { id: ids.projectA, organization_id: EVAL_ORG_ID, name: 'Eval Gardens Phase 1', status: 'active' },
    { id: ids.projectB, organization_id: EVAL_ORG_ID, name: 'Eval Heights', status: 'active' },
    { id: ids.projectC, organization_id: EVAL_ORG_ID, name: 'Eval Riverside', status: 'archived' },
  ]));

  await must(supabaseRaw.from('re_units').insert([
    { id: ids.unitA1, organization_id: EVAL_ORG_ID, project_id: ids.projectA, unit_number: 'A1', list_price: 30_000_000, status: 'sold' },
    { id: ids.unitA2, organization_id: EVAL_ORG_ID, project_id: ids.projectA, unit_number: 'A2', list_price: 28_000_000, status: 'sold' },
    { id: ids.unitB1, organization_id: EVAL_ORG_ID, project_id: ids.projectB, unit_number: 'B1', list_price: 25_000_000, status: 'sold' },
  ]));

  await must(supabaseRaw.from('re_customers').insert([
    { id: ids.customerAlpha, organization_id: EVAL_ORG_ID, full_name: 'Eval Buyer Alpha' },
    { id: ids.customerBravo, organization_id: EVAL_ORG_ID, full_name: 'Eval Buyer Bravo' },
    { id: ids.customerCharlie, organization_id: EVAL_ORG_ID, full_name: 'Eval Buyer Charlie' },
  ]));

  await must(supabaseRaw.from('re_reservations').insert([
    { id: ids.resAlpha, organization_id: EVAL_ORG_ID, unit_id: ids.unitA1, customer_id: ids.customerAlpha, status: 'reserved' },
    // default_risk_score set directly (>HIGH_RISK_THRESHOLD=70) rather than
    // computed from history — defaultRiskService.topDefaultRisks reads this
    // stored column, it does not recompute it live.
    { id: ids.resBravo, organization_id: EVAL_ORG_ID, unit_id: ids.unitB1, customer_id: ids.customerBravo, status: 'reserved', default_risk_score: 85 },
    { id: ids.resCharlie, organization_id: EVAL_ORG_ID, unit_id: ids.unitA2, customer_id: ids.customerCharlie, status: 'reserved' },
  ]));

  await must(supabaseRaw.from('re_installment_plans').insert([
    { id: ids.planAlpha, organization_id: EVAL_ORG_ID, reservation_id: ids.resAlpha, total_amount: 24_000_000, number_of_installments: 12, frequency: 'monthly', start_date: lastMonthStart },
    { id: ids.planBravo, organization_id: EVAL_ORG_ID, reservation_id: ids.resBravo, total_amount: 20_000_000, number_of_installments: 12, frequency: 'monthly', start_date: lastMonthStart },
    { id: ids.planCharlie, organization_id: EVAL_ORG_ID, reservation_id: ids.resCharlie, total_amount: 22_000_000, number_of_installments: 12, frequency: 'monthly', start_date: lastMonthStart },
  ]));

  await must(supabaseRaw.from('re_installment_schedule').insert([
    { id: ids.schedAlpha, organization_id: EVAL_ORG_ID, plan_id: ids.planAlpha, installment_number: 1, due_date: today, amount_due: 2_000_000, status: 'paid', paid_at: `${today}T10:00:00Z` },
    { id: ids.schedBravoPaid, organization_id: EVAL_ORG_ID, plan_id: ids.planBravo, installment_number: 1, due_date: today, amount_due: 500_000, status: 'paid', paid_at: `${today}T09:00:00Z` },
    { id: ids.schedBravoOverdue, organization_id: EVAL_ORG_ID, plan_id: ids.planBravo, installment_number: 2, due_date: overdueDate, amount_due: 300_000, status: 'overdue' },
    { id: ids.schedCharlie, organization_id: EVAL_ORG_ID, plan_id: ids.planCharlie, installment_number: 1, due_date: lastMonthPayDate, amount_due: 4_000_000, status: 'paid', paid_at: `${lastMonthPayDate}T10:00:00Z` },
  ]));

  await must(supabaseRaw.from('re_payments').insert([
    // This month: Eval Gardens Phase 1 (Alpha, 2.0m) > Eval Heights (Bravo, 0.5m) — an unambiguous top project.
    { organization_id: EVAL_ORG_ID, schedule_id: ids.schedAlpha, amount: 2_000_000, method: 'bank_transfer', paid_at: `${today}T10:00:00Z` },
    { organization_id: EVAL_ORG_ID, schedule_id: ids.schedBravoPaid, amount: 500_000, method: 'bank_transfer', paid_at: `${today}T09:00:00Z` },
    // Last month: 4.0m, comfortably above this month's 2.5m total — a real decline to explain.
    { organization_id: EVAL_ORG_ID, schedule_id: ids.schedCharlie, amount: 4_000_000, method: 'bank_transfer', paid_at: `${lastMonthPayDate}T10:00:00Z` },
  ]));

  await must(supabaseRaw.from('re_project_summaries').insert([{
    organization_id: EVAL_ORG_ID,
    project_id: ids.projectC,
    summary_text:
      'Eval Riverside closed with 4 buyers and ₦82,000,000 collected in total. One buyer fell into arrears ' +
      'midway through the project and later recovered after a restructure. The project ran for roughly 14 months ' +
      'from first reservation to completion, and every unit was handed over.',
    key_metrics: { total_buyers: 4, default_rate: 0.25, recovery_rate: 1, completion_days: 420, total_collected: 82_000_000 },
    generated_by: 'fallback',
  }]));
}

// Pure. A key "appears in the context" if it is present, non-null, and —
// for an array or plain object — actually holds something: an empty array
// or empty object is structurally present but carries no data a correct
// answer could actually be grounded in, so it counts as missing.
function missingRequiredKeys(context, requiredKeys) {
  return (requiredKeys || []).filter((key) => {
    const value = (context || {})[key];
    if (value == null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  });
}

// Pure. Case-insensitive substring match — matches tests/ai-evaluation/
// cases.js's own documented mechanism exactly.
function findForbiddenClaims(answerText, forbiddenClaims) {
  const lower = String(answerText || '').toLowerCase();
  return (forbiddenClaims || []).filter((claim) => lower.includes(String(claim).toLowerCase()));
}

async function evaluateCase(testCase) {
  const tokenizer = assistant.createRefTokenizer();
  const category = assistant.detectQuestionCategory(testCase.question);
  const [base, categoryContext, mentionedProjects] = await Promise.all([
    assistant.gatherBaseContext(EVAL_ORG_ID, tokenizer),
    assistant.gatherCategoryContext(EVAL_ORG_ID, category, tokenizer),
    projectSummaries.findMentionedProjectSummaries(EVAL_ORG_ID, testCase.question).catch(() => []),
  ]);
  const context = { ...base, ...categoryContext, question_category: category };
  if (mentionedProjects.length) context.completed_project_history = mentionedProjects;

  const missingDataKeys = missingRequiredKeys(context, testCase.required_data_keys);

  // userId: null — deliberately. There is no admin-user identity to attach
  // (adminAuth is a single shared secret, not a session — routes/admin.js's
  // own client-error reporting makes the same call for the same reason), and
  // askAssistant's own re_ai_conversations insert already treats a failed
  // insert as non-fatal (it warns and leaves conversation_id null), so a
  // null userId simply means this eval run leaves no row in that table
  // rather than polluting a real usage log with synthetic conversations.
  const result = await assistant.askAssistant(EVAL_ORG_ID, null, testCase.question, []);
  const matchedForbiddenClaims = findForbiddenClaims(result.answer, testCase.forbidden_claims);

  return {
    id: testCase.id,
    question: testCase.question,
    expected_reasoning: testCase.expected_reasoning,
    passed: missingDataKeys.length === 0 && matchedForbiddenClaims.length === 0,
    missing_data_keys: missingDataKeys,
    matched_forbidden_claims: matchedForbiddenClaims,
    actual_answer: result.answer,
    generated_by: result.generated_by,
    confidence: result.confidence,
  };
}

async function runEvaluation() {
  await seedEvalWorkspace();

  // Sequential, not parallel — five cases is few enough that runtime is not
  // a concern, and each case already costs up to two OpenAI calls
  // (evaluateCase's own gather + askAssistant's real answer); running them
  // one at a time keeps this rarely-run diagnostic from bursting against
  // whatever OpenAI rate limit the workspace's key is actually under.
  const results = [];
  for (const testCase of CASES) {
    results.push(await evaluateCase(testCase));
  }

  const passCount = results.filter((r) => r.passed).length;
  return {
    ran_at: new Date().toISOString(),
    total: results.length,
    pass_count: passCount,
    fail_count: results.length - passCount,
    results,
  };
}

module.exports = {
  EVAL_ORG_ID,
  seedEvalWorkspace,
  runEvaluation,
  // Exported for logic.test.js — pure, no database, directly unit-testable.
  missingRequiredKeys,
  findForbiddenClaims,
};
