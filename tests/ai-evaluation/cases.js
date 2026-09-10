// tests/ai-evaluation/cases.js — the AI Evaluation System's own evaluation
// cases (admin dashboard Health tab → "AI Accuracy", GET /api/admin/ai-
// evaluation, src/services/aiEvaluationService.js). Each case asks Archta
// Intelligence a real question against the synthetic fixture
// aiEvaluationService.seedEvalWorkspace() builds, and is checked two ways:
//
//   required_data_keys — every key listed must be present, and non-empty,
//   in the SAME context object aiAssistantService.askAssistant() itself
//   builds for this question — i.e. the server actually gathered the data a
//   correct answer would need, before the model ever saw the question. This
//   catches a context-gathering regression even if the model's prose still
//   sounds plausible.
//
//   forbidden_claims — none of these substrings (case-insensitive) may
//   appear anywhere in the model's visible answer text — the answer must
//   never claim ignorance or contradict what the fixture actually contains.
//
// expected_reasoning is NOT auto-graded — there is no reliable way to score
// prose correctness without a second model call judging the first (an AI
// evaluating an AI is its own source of false confidence, not a real check).
// It is returned alongside the actual answer produced so a human admin can
// read both side by side and judge quality directly.
//
// Every question here is written to match aiEvaluationService's own fixture
// exactly — two projects with a clear leader in this month's collections, a
// decline from last month, one overdue buyer who is also the highest default
// risk, and one archived project with a stored institutional-memory summary.
// Changing the fixture without updating these cases (or vice versa) will
// desync required_data_keys/forbidden_claims from what the fixture actually
// produces.
module.exports = [
  {
    id: 'top_collecting_project',
    question: 'Which project collected the most this month?',
    required_data_keys: ['collections_by_project_this_month'],
    forbidden_claims: ["don't have", 'do not have', 'no data', 'unable to determine'],
    expected_reasoning:
      'Should name Eval Gardens Phase 1 as the top-collecting project this month and cite its actual amount ' +
      'from collections_by_project_this_month, which is higher than Eval Heights.',
  },
  {
    id: 'collections_decline',
    question: 'Why did collections decline this month?',
    required_data_keys: ['collections'],
    forbidden_claims: ['collections increased', 'collections are up', 'no decline'],
    expected_reasoning:
      "Should state that this month's collections are lower than last month's, citing both totals from " +
      'context.collections, rather than claiming collections are flat or improving.',
  },
  {
    id: 'highest_risk_buyers',
    question: 'Which buyers are highest risk right now?',
    required_data_keys: ['at_risk_buyers', 'top_defaulting_buyers'],
    forbidden_claims: ['no buyers are at risk', 'no buyers are high risk', "don't have", 'do not have'],
    expected_reasoning:
      'Should name the specific highest-risk buyer (resolved from their BUYER_N token to their real name), ' +
      'citing their overdue amount and/or default risk score from the context.',
  },
  {
    id: 'overdue_buyer_count',
    question: 'How many buyers are currently overdue?',
    required_data_keys: ['overdue'],
    forbidden_claims: ['zero buyers', 'no buyers are overdue', "don't have", 'do not have'],
    expected_reasoning:
      'Should state the exact overdue buyer_count from context.overdue, and ideally the total overdue amount too.',
  },
  {
    id: 'completed_project_history',
    question: 'What happened with Eval Riverside?',
    required_data_keys: ['completed_project_history'],
    forbidden_claims: ["don't have", 'do not have', 'no information', 'not aware'],
    expected_reasoning:
      "Should relay Eval Riverside's recorded key_metrics (buyer count, total collected) as verified fact, and " +
      'present its stored narrative summary as a prior AI interpretation rather than a newly confirmed fact, per ' +
      "the system prompt's own instruction distinguishing the two.",
  },
];
