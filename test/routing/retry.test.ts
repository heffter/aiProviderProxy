/**
 * Pre-stream retry unit tests (epic AIPP-10, subtask 10.3; FR-ROUTE-008/009/017).
 */

import { describe, it, expect } from 'vitest';
import {
  isPreStreamRetryable,
  backoffDelayMs,
  shouldPreStreamRetry,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from '../../src/routing/retry.js';
import { isRetryable } from '../../src/providers/errors.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';

const safe = { preStream: true, postStream: false };

describe('isPreStreamRetryable', () => {
  it('retries only connection and timeout categories', () => {
    expect(isPreStreamRetryable('provider_connection_error')).toBe(true);
    expect(isPreStreamRetryable('provider_timeout')).toBe(true);
    // Rate-limit/overload are reliability fallbacks, not same-model retries.
    expect(isPreStreamRetryable('provider_rate_limited')).toBe(false);
    expect(isPreStreamRetryable('provider_overloaded')).toBe(false);
    expect(isPreStreamRetryable('provider_validation_error')).toBe(false);
    expect(isPreStreamRetryable('provider_auth_error')).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  const noJitter: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: false };

  it('is exponential and capped without jitter', () => {
    expect(backoffDelayMs(0, noJitter)).toBe(250);
    expect(backoffDelayMs(1, noJitter)).toBe(500);
    expect(backoffDelayMs(2, noJitter)).toBe(1000);
    expect(backoffDelayMs(10, noJitter)).toBe(4000); // capped at maxDelayMs
  });

  it('applies full jitter in [cap/2, cap] with the injected RNG', () => {
    // rand=0 -> lower bound (cap/2); rand=1 -> upper bound (cap).
    expect(backoffDelayMs(0, DEFAULT_RETRY_POLICY, () => 0)).toBe(125);
    expect(backoffDelayMs(0, DEFAULT_RETRY_POLICY, () => 1)).toBe(250);
    expect(backoffDelayMs(1, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(375);
  });
});

describe('shouldPreStreamRetry', () => {
  it('gates on adapter safety, category, and retry budget', () => {
    expect(
      shouldPreStreamRetry('provider_timeout', 0, DEFAULT_RETRY_POLICY, safe),
    ).toBe(true);
    // Budget exhausted (maxRetries = 2).
    expect(
      shouldPreStreamRetry('provider_timeout', 2, DEFAULT_RETRY_POLICY, safe),
    ).toBe(false);
    // Non-retryable category.
    expect(
      shouldPreStreamRetry(
        'provider_rate_limited',
        0,
        DEFAULT_RETRY_POLICY,
        safe,
      ),
    ).toBe(false);
    // Adapter forbids pre-stream retry.
    expect(
      shouldPreStreamRetry('provider_timeout', 0, DEFAULT_RETRY_POLICY, {
        preStream: false,
        postStream: false,
      }),
    ).toBe(false);
  });
});

describe('post-stream retry is forbidden (FR-ROUTE-008/009)', () => {
  it('every registered adapter declares postStream retry unsafe', () => {
    const registry = buildProviderRegistry({
      env: {} as NodeJS.ProcessEnv,
    });
    for (const id of ['anthropic', 'openai', 'google', 'ollama', 'zai']) {
      expect(registry.get(id).retrySafety.postStream).toBe(false);
    }
  });

  it('isRetryable never permits a post-stream retry for these adapters', () => {
    expect(isRetryable('provider_timeout', 'post_stream', safe)).toBe(false);
    expect(isRetryable('provider_connection_error', 'pre_stream', safe)).toBe(
      true,
    );
  });
});
