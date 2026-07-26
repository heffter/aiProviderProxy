/**
 * Routing engine: modes, complexity classification, capability-preserving
 * candidate selection (epic AIPP-10; PRD section 11.12).
 *
 * The engine (engine.ts) turns a surface-agnostic request into an ordered
 * candidate list plus a decision record; the classifier (complexity.ts) scores
 * prompt complexity. Structured attempt records, retry/backoff, cross-provider
 * fallback, and live policy enforcement layer on in later subtasks.
 */

/** Identifies this module within the target skeleton. */
export const MODULE_NAME = 'routing';

export {
  classifyComplexity,
  messageText,
  normalizeMessages,
  type Complexity,
  type ClassifierMessage,
  type ComplexityResult,
} from './complexity.js';

export {
  planRoute,
  filterByCapabilities,
  knownUnsupported,
  requiredCapabilitiesFor,
  type RoutingRequest,
  type RoutingDecision,
  type RoutingCandidate,
  type RoutingConfig,
  type RoutePlannerContext,
  type ModelResolver,
} from './engine.js';

export {
  checkDowngrade,
  applyDowngradeHeaders,
  isReliabilityStatus,
  isReliabilityCategory,
  DEFAULT_DOWNGRADE_MAPPING,
  DEFAULT_DOWNGRADE_CONFIG,
  RELIABILITY_TRIGGER_CATEGORIES,
  type FallbackTrigger,
  type DowngradeConfig,
  type DowngradeResult,
} from './fallback.js';

export {
  isPreStreamRetryable,
  backoffDelayMs,
  shouldPreStreamRetry,
  PRESTREAM_RETRYABLE_CATEGORIES,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from './retry.js';
