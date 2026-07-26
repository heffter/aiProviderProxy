/**
 * OpenAI Chat Completions error envelope (epic AIPP-8, subtask 8.1;
 * FR-CHAT-001..010).
 *
 * The client-facing error shape for the `POST /v1/chat/completions` surface:
 * `{ "error": { "message", "type", "param", "code" } }`, plus the HTTP status
 * each error type maps to. This mirrors the OpenAI error wire format so OpenAI
 * SDK clients see the errors they expect. Client-facing envelopes are produced
 * here; the canonical error classifier (AIPP-4) owns the internal category
 * layer.
 */

/** OpenAI Chat error type discriminators. */
export type ChatErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error';

/** The OpenAI error envelope returned to clients on the Chat surface. */
export interface ChatErrorEnvelope {
  error: {
    message: string;
    type: ChatErrorType;
    param: string | null;
    code: string | null;
  };
}

/** Optional detail attached to a Chat error envelope. */
export interface ChatErrorDetail {
  param?: string;
  code?: string;
}

/** Build an OpenAI Chat error envelope. */
export function chatError(
  type: ChatErrorType,
  message: string,
  detail: ChatErrorDetail = {},
): ChatErrorEnvelope {
  return {
    error: {
      message,
      type,
      param: detail.param ?? null,
      code: detail.code ?? null,
    },
  };
}

/** HTTP status for an OpenAI Chat error type. */
export function statusForChatError(type: ChatErrorType): number {
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
