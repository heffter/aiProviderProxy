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
