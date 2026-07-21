/**
 * Canonical error classifier (epic AIPP-4, subtask 4.6; PRD section 13).
 *
 * Maps provider status codes, provider error-body types, and thrown connection
 * failures to the canonical {@link ErrorCategory} set. All adapters classify
 * through here, and retry logic keys on categories ONLY -- never on error
 * message strings -- so a provider changing its wording can never change retry
 * behaviour.
 */

import type { ErrorCategory, ErrorClassifierInput } from './types.js';

/** Categories that are safe to retry (subject to per-adapter retry safety). */
export const RETRYABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  'provider_rate_limited',
  'provider_overloaded',
  'provider_timeout',
  'provider_connection_error',
  'provider_stream_error',
]);

/** A classification result retaining provider status where safe. */
export interface Classification {
  category: ErrorCategory;
  status?: number;
  providerRequestId?: string;
}

interface ErrorLike {
  code?: string;
  name?: string;
  message?: string;
}

function asErrorLike(cause: unknown): ErrorLike {
  if (cause && typeof cause === 'object') {
    return cause as ErrorLike;
  }
  return {};
}

/** Classify a thrown transport error, or undefined if it is not a connection failure. */
export function classifyConnectionError(
  cause: unknown,
): ErrorCategory | undefined {
  if (cause === undefined || cause === null) {
    return undefined;
  }
  const err = asErrorLike(cause);
  const code = (err.code ?? '').toUpperCase();
  const name = err.name ?? '';
  if (
    name === 'AbortError' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT'
  ) {
    return 'provider_timeout';
  }
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return 'provider_connection_error';
  }
  // Any other thrown transport error is a connection error, not a fallthrough.
  return 'provider_connection_error';
}

/** Map a bare HTTP status to a canonical category. */
export function classifyHttpStatus(status: number): ErrorCategory {
  if (status === 400 || status === 422) {
    return 'provider_validation_error';
  }
  if (status === 401 || status === 403) {
    return 'provider_auth_error';
  }
  if (status === 408) {
    return 'provider_timeout';
  }
  if (status === 429) {
    return 'provider_rate_limited';
  }
  if (status === 503 || status === 529) {
    return 'provider_overloaded';
  }
  if (status === 504) {
    return 'provider_timeout';
  }
  if (status >= 500) {
    return 'provider_overloaded';
  }
  if (status >= 400) {
    return 'provider_validation_error';
  }
  return 'internal_error';
}

function errorBodyType(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const type = (error as { type?: unknown }).type;
      if (typeof type === 'string') {
        return type;
      }
    }
    // Some providers put `type` at the top level.
    const topType = (body as { type?: unknown }).type;
    if (typeof topType === 'string' && topType === 'error') {
      return undefined;
    }
  }
  return undefined;
}

/** Anthropic error-type -> category (falls back to status). */
export function classifyAnthropicError(
  input: ErrorClassifierInput,
): ErrorCategory {
  const connection = classifyConnectionError(input.cause);
  if (connection) {
    return connection;
  }
  switch (errorBodyType(input.body)) {
    case 'authentication_error':
    case 'permission_error':
      return 'provider_auth_error';
    case 'rate_limit_error':
      return 'provider_rate_limited';
    case 'overloaded_error':
      return 'provider_overloaded';
    case 'invalid_request_error':
      return 'provider_validation_error';
    case 'timeout_error':
      return 'provider_timeout';
    case 'api_error':
      return 'provider_overloaded';
    default:
      return input.status !== undefined
        ? classifyHttpStatus(input.status)
        : 'internal_error';
  }
}

/** OpenAI (and openai-compatible) error-type -> category (falls back to status). */
export function classifyOpenAIError(
  input: ErrorClassifierInput,
): ErrorCategory {
  const connection = classifyConnectionError(input.cause);
  if (connection) {
    return connection;
  }
  switch (errorBodyType(input.body)) {
    case 'invalid_request_error':
      return 'provider_validation_error';
    case 'authentication_error':
    case 'invalid_api_key':
      return 'provider_auth_error';
    case 'insufficient_quota':
      return 'provider_rate_limited';
    case 'rate_limit_error':
    case 'requests':
    case 'tokens':
      return 'provider_rate_limited';
    case 'server_error':
      return 'provider_overloaded';
    default:
      return input.status !== undefined
        ? classifyHttpStatus(input.status)
        : 'internal_error';
  }
}

/** Generic classifier: connection first, then status. */
export function classifyGenericError(
  input: ErrorClassifierInput,
): ErrorCategory {
  const connection = classifyConnectionError(input.cause);
  if (connection) {
    return connection;
  }
  return input.status !== undefined
    ? classifyHttpStatus(input.status)
    : 'internal_error';
}

/**
 * Decide whether an attempt with the given category may be retried. Keys on the
 * category and stream phase ONLY (never a message string).
 */
export function isRetryable(
  category: ErrorCategory,
  phase: 'pre_stream' | 'post_stream',
  retrySafety: { preStream: boolean; postStream: boolean },
): boolean {
  if (!RETRYABLE_CATEGORIES.has(category)) {
    return false;
  }
  return phase === 'pre_stream'
    ? retrySafety.preStream
    : retrySafety.postStream;
}
