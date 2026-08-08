/**
 * Anthropic Messages request parsing + validation (epic AIPP-6, subtask 6.1;
 * FR-ANTH-001..017).
 *
 * Parses and validates a `POST /v1/messages` body, returning either a typed
 * request or an Anthropic error envelope with the right HTTP status. Validation
 * mirrors the Anthropic API: required model / messages / max_tokens, valid roles,
 * and structurally valid content blocks. It does not inspect or copy content
 * text beyond what validation needs.
 */

import {
  anthropicError,
  statusForAnthropicError,
  type AnthropicErrorEnvelope,
} from './errors.js';

/** A parsed, validated Messages request (structure only). */
export interface ParsedMessagesRequest {
  model: string;
  messages: MessageInput[];
  max_tokens: number;
  system?: unknown;
  stream: boolean;
  tools?: unknown[];
  raw: Record<string, unknown>;
}

/**
 * A single input message (role + content).
 *
 * `system` is a mid-conversation system message: an operator instruction placed
 * in the `messages` array rather than the top-level `system` field, so it does
 * not invalidate the cached prefix. Claude Code sends these, and the upstream
 * API accepts them on the models that support the feature.
 */
export interface MessageInput {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

/** A content block (only `type` is required to be a string). */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export type ParseResult =
  | { ok: true; request: ParsedMessagesRequest }
  | { ok: false; status: number; error: AnthropicErrorEnvelope };

function fail(message: string): {
  ok: false;
  status: number;
  error: AnthropicErrorEnvelope;
} {
  return {
    ok: false,
    status: statusForAnthropicError('invalid_request_error'),
    error: anthropicError('invalid_request_error', message),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateMessage(message: unknown, index: number): string | undefined {
  if (!isObject(message)) {
    return `messages.${index}: must be an object`;
  }
  const role = message.role;
  // `system` is accepted alongside user/assistant: a mid-conversation system
  // message is a valid Messages request on the models that support it, and the
  // gateway must not be stricter than the upstream it proxies -- rejecting a
  // request the real API would accept is the worse failure, since the client
  // has no way around it. Placement rules (must follow a user turn, never
  // first, text-only) are deliberately left to the upstream to enforce.
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    return `messages.${index}.role: must be "user", "assistant", or "system"`;
  }
  const content = message.content;
  if (typeof content === 'string') {
    return undefined;
  }
  if (!Array.isArray(content)) {
    return `messages.${index}.content: must be a string or an array of content blocks`;
  }
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i];
    if (!isObject(block) || typeof block.type !== 'string') {
      return `messages.${index}.content.${i}: each content block must have a string "type"`;
    }
  }
  return undefined;
}

/**
 * Parse and validate a Messages request body (string or already-parsed value).
 */
export function parseMessagesRequest(rawBody: string | unknown): ParseResult {
  let body: unknown = rawBody;
  if (typeof rawBody === 'string') {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return fail('Request body is not valid JSON');
    }
  }
  if (!isObject(body)) {
    return fail('Request body must be a JSON object');
  }

  if (typeof body.model !== 'string' || body.model.length === 0) {
    return fail('model: Field required');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return fail('messages: Field required and must be a non-empty array');
  }
  for (let i = 0; i < body.messages.length; i += 1) {
    const error = validateMessage(body.messages[i], i);
    if (error) {
      return fail(error);
    }
  }
  if (
    typeof body.max_tokens !== 'number' ||
    !Number.isInteger(body.max_tokens) ||
    body.max_tokens <= 0
  ) {
    return fail('max_tokens: Field required and must be a positive integer');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return fail('stream: must be a boolean');
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return fail('tools: must be an array');
  }

  return {
    ok: true,
    request: {
      model: body.model,
      messages: body.messages as MessageInput[],
      max_tokens: body.max_tokens,
      system: body.system,
      stream: body.stream === true,
      tools: body.tools as unknown[] | undefined,
      raw: body,
    },
  };
}
