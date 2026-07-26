/**
 * OpenAI Chat Completions request parsing + validation (epic AIPP-8, subtask
 * 8.1; FR-CHAT-001..010, FR-TOOLS-001/009).
 *
 * Parses and validates a `POST /v1/chat/completions` body into a typed request,
 * or returns an OpenAI-shaped error envelope with the right HTTP status.
 * Validation mirrors the Chat Completions API: a required model, a non-empty
 * messages array with valid roles, structurally valid tool definitions, and the
 * common sampling/streaming controls. The parser inspects structure only; it
 * does not copy message text beyond what validation requires.
 */

import {
  chatError,
  statusForChatError,
  type ChatErrorEnvelope,
} from './errors.js';

/** A single chat message (role + content, plus tool linkage). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content?: unknown;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [key: string]: unknown;
}

/** A parsed, validated Chat Completions request (structure only). */
export interface ParsedChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  raw: Record<string, unknown>;
}

export type ChatParseResult =
  | { ok: true; request: ParsedChatRequest }
  | { ok: false; status: number; error: ChatErrorEnvelope };

const ROLES: ReadonlySet<string> = new Set([
  'system',
  'user',
  'assistant',
  'tool',
  'developer',
]);

function invalid(
  message: string,
  param?: string,
): { ok: false; status: number; error: ChatErrorEnvelope } {
  return {
    ok: false,
    status: statusForChatError('invalid_request_error'),
    error: chatError('invalid_request_error', message, { param }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate one message, returning an error string or undefined. */
function validateMessage(message: unknown, index: number): string | undefined {
  if (!isObject(message)) {
    return `messages.${index}: must be an object`;
  }
  const role = message.role;
  if (typeof role !== 'string' || !ROLES.has(role)) {
    return `messages.${index}.role: must be one of system, user, assistant, tool, developer`;
  }
  // A tool message must reference the call it answers.
  if (
    role === 'tool' &&
    (typeof message.tool_call_id !== 'string' ||
      message.tool_call_id.length === 0)
  ) {
    return `messages.${index}.tool_call_id: Field required for tool messages`;
  }
  // Content is required unless an assistant message carries tool_calls.
  const hasToolCalls =
    role === 'assistant' &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0;
  const content = message.content;
  if (content === undefined || content === null) {
    if (!hasToolCalls) {
      return `messages.${index}.content: Field required`;
    }
  } else if (typeof content !== 'string' && !Array.isArray(content)) {
    return `messages.${index}.content: must be a string or an array of content parts`;
  }
  return undefined;
}

/** Parse and validate a Chat Completions request body. */
export function parseChatRequest(rawBody: string | unknown): ChatParseResult {
  let body: unknown = rawBody;
  if (typeof rawBody === 'string') {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return invalid('Request body is not valid JSON');
    }
  }
  if (!isObject(body)) {
    return invalid('Request body must be a JSON object');
  }

  if (typeof body.model !== 'string' || body.model.length === 0) {
    return invalid('model: Field required', 'model');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return invalid(
      'messages: Field required and must be a non-empty array',
      'messages',
    );
  }
  for (let i = 0; i < body.messages.length; i += 1) {
    const error = validateMessage(body.messages[i], i);
    if (error) {
      return invalid(error, 'messages');
    }
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return invalid('stream: must be a boolean', 'stream');
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return invalid('tools: must be an array', 'tools');
  }
  if (body.max_tokens !== undefined) {
    if (
      typeof body.max_tokens !== 'number' ||
      !Number.isInteger(body.max_tokens) ||
      body.max_tokens <= 0
    ) {
      return invalid('max_tokens: must be a positive integer', 'max_tokens');
    }
  }

  return {
    ok: true,
    request: {
      model: body.model,
      messages: body.messages as ChatMessage[],
      stream: body.stream === true,
      tools: body.tools as unknown[] | undefined,
      toolChoice: body.tool_choice,
      maxTokens:
        typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      temperature:
        typeof body.temperature === 'number' ? body.temperature : undefined,
      topP: typeof body.top_p === 'number' ? body.top_p : undefined,
      raw: body,
    },
  };
}
