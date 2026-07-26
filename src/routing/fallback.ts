/**
 * Fallback triggers and budget downgrade (epic AIPP-10, subtask 10.2;
 * FR-ROUTE-004/006/012/013/014).
 *
 * The taxonomy that distinguishes WHY a second attempt happened, plus the pure
 * budget-downgrade port (downgrade.ts) and the reliability-trigger predicates the
 * execution loop keys on. Each trigger surfaces on the lifecycle
 * `Attempt.routing.fallbackTrigger` so downgrade, reliability fallback, and
 * account rotation are separable in usage events and the routing log.
 */

import type { ErrorCategory } from '../providers/types.js';

/** Why an attempt after the first one was made. */
export type FallbackTrigger =
  /** A cross-provider or same-provider retry after a reliability failure. */
  | 'reliability'
  /** A budget-driven model downgrade to a cheaper model. */
  | 'downgrade'
  /** A same-provider switch to a different account/credential. */
  | 'rotation'
  /** A same-provider escalation to a stronger model (cascade quality). */
  | 'escalation';

/** Budget auto-downgrade configuration (ported from the legacy proxy). */
export interface DowngradeConfig {
  enabled: boolean;
  /** Budget-utilisation percent (0-100+) at which downgrade kicks in. */
  thresholdPercent: number;
  /** Expensive-model -> cheaper-model map. */
  mapping: Record<string, string>;
}

/** The outcome of a downgrade check. */
export interface DowngradeResult {
  downgraded: boolean;
  originalModel: string;
  newModel: string;
  reason: string;
}

/**
 * Default expensive -> cheaper model map (ported from downgrade.ts). Keys are
 * native model ids; a downgrade only fires when the requested model has an entry.
 */
export const DEFAULT_DOWNGRADE_MAPPING: Record<string, string> = {
  // Anthropic
  'claude-opus-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-latest': 'claude-sonnet-4-latest',
  'claude-3-opus-20240229': 'claude-3-5-sonnet-20241022',
  'claude-sonnet-4-6': 'claude-3-5-haiku-20241022',
  'claude-sonnet-4-latest': 'claude-3-5-haiku-latest',
  'claude-3-5-sonnet-20241022': 'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-latest': 'claude-3-5-haiku-latest',
  // OpenAI
  'gpt-4o': 'gpt-4o-mini',
  'gpt-4-turbo': 'gpt-4o-mini',
  o1: 'o3-mini',
  // Google
  'gemini-2.5-pro': 'gemini-2.0-flash',
  'gemini-1.5-pro': 'gemini-1.5-flash',
};

/** The default downgrade configuration: disabled, 80% threshold. */
export const DEFAULT_DOWNGRADE_CONFIG: DowngradeConfig = {
  enabled: false,
  thresholdPercent: 80,
  mapping: { ...DEFAULT_DOWNGRADE_MAPPING },
};

/**
 * Decide whether `model` should be downgraded given current budget utilisation.
 * A no-op unless downgrade is enabled, the threshold is met, and a mapping
 * exists for the model.
 */
export function checkDowngrade(
  model: string,
  budgetPercent: number,
  config: DowngradeConfig = DEFAULT_DOWNGRADE_CONFIG,
): DowngradeResult {
  const noChange = (reason = ''): DowngradeResult => ({
    downgraded: false,
    originalModel: model,
    newModel: model,
    reason,
  });
  if (!config.enabled || budgetPercent < config.thresholdPercent) {
    return noChange();
  }
  const cheaper = config.mapping[model];
  if (!cheaper) {
    return noChange('no mapping available');
  }
  return {
    downgraded: true,
    originalModel: model,
    newModel: cheaper,
    reason: `budget at ${budgetPercent.toFixed(1)}% (threshold: ${config.thresholdPercent}%)`,
  };
}

/**
 * Stamp downgrade markers onto a response header map (gateway `x-aipp-*`
 * convention; the legacy `X-RelayPlane-*` headers are not emitted).
 */
export function applyDowngradeHeaders(
  headers: Record<string, string>,
  result: DowngradeResult,
): void {
  if (result.downgraded) {
    headers['x-aipp-downgraded'] = 'true';
    headers['x-aipp-downgrade-reason'] = result.reason;
    headers['x-aipp-original-model'] = result.originalModel;
  }
}

/**
 * Error categories that make a pre-output cross-provider/same-provider retry
 * worthwhile: transient upstream conditions, never client or validation faults.
 */
export const RELIABILITY_TRIGGER_CATEGORIES: ReadonlySet<ErrorCategory> =
  new Set<ErrorCategory>([
    'provider_rate_limited',
    'provider_overloaded',
    'provider_timeout',
    'provider_connection_error',
  ]);

/** True when an HTTP status is one of the configured reliability triggers. */
export function isReliabilityStatus(
  status: number | undefined,
  triggerStatuses: readonly number[],
): boolean {
  return status !== undefined && triggerStatuses.includes(status);
}

/** True when an error category warrants a reliability fallback. */
export function isReliabilityCategory(category: ErrorCategory): boolean {
  return RELIABILITY_TRIGGER_CATEGORIES.has(category);
}
