/**
 * Unified budget enforcement (epic AIPP-11, subtask 11.2).
 */

export {
  BudgetManager,
  estimateCostFromTokens,
  dailyWindow,
  hourlyWindow,
  MODEL_PRICING,
  DEFAULT_BUDGET_CONFIG,
  type BudgetConfig,
  type BudgetDecision,
  type BudgetStatus,
  type BreachAction,
  type BreachType,
  type BudgetManagerOptions,
} from './budget.js';

export { BudgetSink } from './sink.js';
