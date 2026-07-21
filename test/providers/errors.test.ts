/**
 * Classification fixture tables for the canonical error classifier
 * (epic AIPP-4, subtask 4.6).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyAnthropicError,
  classifyConnectionError,
  classifyGenericError,
  classifyHttpStatus,
  classifyOpenAIError,
  isRetryable,
  RETRYABLE_CATEGORIES,
} from '../../src/providers/errors.js';
import type { ErrorCategory } from '../../src/providers/types.js';

describe('classifyHttpStatus', () => {
  const table: Array<[number, ErrorCategory]> = [
    [400, 'provider_validation_error'],
    [401, 'provider_auth_error'],
    [403, 'provider_auth_error'],
    [408, 'provider_timeout'],
    [429, 'provider_rate_limited'],
    [500, 'provider_overloaded'],
    [503, 'provider_overloaded'],
    [504, 'provider_timeout'],
    [529, 'provider_overloaded'],
  ];
  it.each(table)('status %i -> %s', (status, expected) => {
    expect(classifyHttpStatus(status)).toBe(expected);
  });
});

describe('classifyConnectionError', () => {
  it('maps timeout and connection codes', () => {
    expect(classifyConnectionError({ code: 'ETIMEDOUT' })).toBe(
      'provider_timeout',
    );
    expect(classifyConnectionError({ name: 'AbortError' })).toBe(
      'provider_timeout',
    );
    expect(classifyConnectionError({ code: 'ECONNRESET' })).toBe(
      'provider_connection_error',
    );
    expect(classifyConnectionError(new Error('socket hang up'))).toBe(
      'provider_connection_error',
    );
    expect(classifyConnectionError(undefined)).toBeUndefined();
  });
});

describe('classifyAnthropicError', () => {
  const table: Array<[string, ErrorCategory]> = [
    ['authentication_error', 'provider_auth_error'],
    ['rate_limit_error', 'provider_rate_limited'],
    ['overloaded_error', 'provider_overloaded'],
    ['invalid_request_error', 'provider_validation_error'],
  ];
  it.each(table)('anthropic error type %s -> %s', (type, expected) => {
    expect(
      classifyAnthropicError({
        status: 400,
        body: { type: 'error', error: { type } },
      }),
    ).toBe(expected);
  });

  it('falls back to status when the body has no known type', () => {
    expect(classifyAnthropicError({ status: 529, body: {} })).toBe(
      'provider_overloaded',
    );
  });

  it('prefers a connection error over the body', () => {
    expect(
      classifyAnthropicError({ cause: { code: 'ECONNRESET' }, status: 500 }),
    ).toBe('provider_connection_error');
  });
});

describe('classifyOpenAIError', () => {
  const table: Array<[string, ErrorCategory]> = [
    ['invalid_request_error', 'provider_validation_error'],
    ['invalid_api_key', 'provider_auth_error'],
    ['insufficient_quota', 'provider_rate_limited'],
    ['server_error', 'provider_overloaded'],
  ];
  it.each(table)('openai error type %s -> %s', (type, expected) => {
    expect(
      classifyOpenAIError({ status: 400, body: { error: { type } } }),
    ).toBe(expected);
  });
});

describe('classifyGenericError', () => {
  it('uses status when no cause, and internal_error when neither', () => {
    expect(classifyGenericError({ status: 429 })).toBe('provider_rate_limited');
    expect(classifyGenericError({})).toBe('internal_error');
  });
});

describe('isRetryable keys on category only (no message matching)', () => {
  const safety = { preStream: true, postStream: false };

  it('retries retryable categories pre-stream but not post-stream', () => {
    for (const category of RETRYABLE_CATEGORIES) {
      expect(isRetryable(category, 'pre_stream', safety)).toBe(true);
      expect(isRetryable(category, 'post_stream', safety)).toBe(false);
    }
  });

  it('never retries non-retryable categories', () => {
    for (const category of [
      'provider_auth_error',
      'provider_validation_error',
      'client_cancelled',
    ] as ErrorCategory[]) {
      expect(isRetryable(category, 'pre_stream', safety)).toBe(false);
    }
  });

  it('is independent of any error message (signature takes only category/phase/safety)', () => {
    // Same category, regardless of the words a provider used, retries identically.
    const a = classifyOpenAIError({
      status: 429,
      body: { error: { type: 'requests', message: 'slow down please' } },
    });
    const b = classifyOpenAIError({
      status: 429,
      body: { error: { type: 'requests', message: 'RATE LIMITED, back off' } },
    });
    expect(a).toBe(b);
    expect(isRetryable(a, 'pre_stream', safety)).toBe(
      isRetryable(b, 'pre_stream', safety),
    );
  });
});
