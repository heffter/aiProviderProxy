/**
 * Anthropic error envelope (epic AIPP-6, subtask 6.1; FR-ANTH-001..017).
 *
 * The client-facing error shape for the Anthropic Messages surface:
 * `{ "type": "error", "error": { "type", "message" } }`, plus the HTTP status
 * each error type maps to. Client-facing envelopes are produced here; the
 * canonical error classifier (AIPP-4) owns the internal category layer.
 */

/** Anthropic error type discriminators. */
export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error';

/** The Anthropic error envelope returned to clients. */
export interface AnthropicErrorEnvelope {
  type: 'error';
  error: { type: AnthropicErrorType; message: string };
}

/** Build an Anthropic error envelope. */
export function anthropicError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorEnvelope {
  return { type: 'error', error: { type, message } };
}

/** HTTP status for an Anthropic error type. */
export function statusForAnthropicError(type: AnthropicErrorType): number {
  switch (type) {
    case 'invalid_request_error':
      return 400;
    case 'authentication_error':
      return 401;
    case 'permission_error':
      return 403;
    case 'not_found_error':
      return 404;
    case 'rate_limit_error':
      return 429;
    case 'overloaded_error':
      return 529;
    case 'api_error':
      return 500;
    default:
      return 500;
  }
}
