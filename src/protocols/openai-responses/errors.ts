/**
 * OpenAI Responses error envelope (epic AIPP-7, subtask 7.1; FR-RESP-001..017).
 *
 * The client-facing error shape for the OpenAI Responses surface:
 * `{ "error": { "message", "type", "param", "code" } }`, plus the HTTP status
 * each error type maps to. This mirrors the OpenAI error wire format so Codex
 * and OpenAI-SDK clients see the errors they expect. Client-facing envelopes are
 * produced here; the canonical error classifier (AIPP-4) owns the internal
 * category layer.
 */

/** OpenAI Responses error type discriminators. */
export type ResponsesErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error';

/** The OpenAI error envelope returned to clients on the Responses surface. */
export interface ResponsesErrorEnvelope {
  error: {
    message: string;
    type: ResponsesErrorType;
    /** The offending request field, when one can be named. */
    param: string | null;
    /** A machine-readable error code, when one applies. */
    code: string | null;
  };
}

/** Optional detail attached to a Responses error envelope. */
export interface ResponsesErrorDetail {
  param?: string;
  code?: string;
}

/** Build an OpenAI Responses error envelope. */
export function responsesError(
  type: ResponsesErrorType,
  message: string,
  detail: ResponsesErrorDetail = {},
): ResponsesErrorEnvelope {
  return {
    error: {
      message,
      type,
      param: detail.param ?? null,
      code: detail.code ?? null,
    },
  };
}

/**
 * Build a capability-unsupported error: a request that is syntactically valid
 * but names a feature this gateway does not implement (e.g. stored response
 * state, hosted tools on a non-OpenAI upstream). OpenAI shape: an
 * `invalid_request_error` carrying a descriptive `code` (FR-RESP-011/012).
 */
export function capabilityError(
  message: string,
  detail: ResponsesErrorDetail = {},
): ResponsesErrorEnvelope {
  return responsesError('invalid_request_error', message, {
    code: detail.code ?? 'unsupported_capability',
    param: detail.param,
  });
}

/** HTTP status for an OpenAI Responses error type. */
export function statusForResponsesError(type: ResponsesErrorType): number {
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
    case 'server_error':
      return 500;
    default:
      return 500;
  }
}
