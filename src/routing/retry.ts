/**
 * Pre-stream retry with backoff (epic AIPP-10, subtask 10.3; FR-PROV-011,
 * FR-ROUTE-008/009/017).
 *
 * A same-model retry that runs BEFORE any client-visible output, bounded and
 * gated by the adapter's retry-safety declaration. It applies only to the
 * transient transport failures that a fresh call can plausibly fix --
 * connection errors and timeouts -- never to rate-limit/overload (those are
 * reliability FALLBACKS to a different candidate, handled by the routing loop)
 * and never to client or validation faults.
 *
 * Post-stream retry is forbidden: none of the v1 client surfaces can recover a
 * stream once bytes have been emitted, so every adapter declares
 * `retrySafety.postStream = false` and this module only ever gates the
 * pre-stream phase.
 */

import type { ErrorCategory } from '../providers/types.js';

/** Categories eligible for a same-model pre-stream retry. */
export const PRESTREAM_RETRYABLE_CATEGORIES: ReadonlySet<ErrorCategory> =
  new Set<ErrorCategory>(['provider_connection_error', 'provider_timeout']);

/** True when a category can be retried on the same model before output. */
export function isPreStreamRetryable(category: ErrorCategory): boolean {
  return PRESTREAM_RETRYABLE_CATEGORIES.has(category);
}

/** Bounded exponential-backoff retry policy. */
export interface RetryPolicy {
  /** Maximum same-model retries before falling back (0 disables retry). */
  maxRetries: number;
  /** Base delay for the first retry, doubled each subsequent retry. */
  baseDelayMs: number;
  /** Ceiling for a single backoff delay. */
  maxDelayMs: number;
  /** Apply full jitter to spread retries across callers. */
  jitter: boolean;
}

/** The default retry policy: 2 retries, 250ms base, 4s cap, jittered. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  jitter: true,
};

/**
 * The backoff delay before retry number `retryIndex` (0-based). Exponential
 * (`base * 2^retryIndex`) capped at `maxDelayMs`; with jitter enabled, a full
 * jitter in `[cap/2, cap]` using the injected RNG (default {@link Math.random}).
 */
export function backoffDelayMs(
  retryIndex: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retryIndex);
  if (!policy.jitter) {
    return exp;
  }
  const half = exp / 2;
  return Math.round(half + rand() * half);
}

/**
 * Whether a failed attempt should be retried on the same model. Requires the
 * adapter to permit pre-stream retry, the category to be pre-stream-retryable,
 * and the retry budget not yet exhausted.
 */
export function shouldPreStreamRetry(
  category: ErrorCategory,
  retryCount: number,
  policy: RetryPolicy,
  retrySafety: { preStream: boolean; postStream: boolean },
): boolean {
  return (
    retrySafety.preStream &&
    isPreStreamRetryable(category) &&
    retryCount < policy.maxRetries
  );
}
