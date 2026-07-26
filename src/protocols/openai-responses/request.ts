/**
 * OpenAI Responses request parsing + validation (epic AIPP-7, subtask 7.1;
 * FR-RESP-001..017, FR-TOOLS-001/009).
 *
 * Parses and validates a `POST /v1/responses` body into a normalized, typed
 * request, or returns an OpenAI-shaped error envelope with the right HTTP
 * status. Validation mirrors the Responses API surface Codex exercises:
 *
 *   - `input` is a string (shorthand for a single user message) or an array of
 *     structured input items (messages with content parts, prior function calls,
 *     and function-call outputs).
 *   - `tools` are classified into function tools and hosted tools; the hosted
 *     kinds are recognized so the routing layer can apply the explicit
 *     pass-through-or-reject policy (subtask 7.4). Unknown tool types are a
 *     validation error.
 *   - `previous_response_id` is rejected with a capability error: this gateway
 *     stores no response state, so it cannot resume a prior response (v1).
 *
 * The parser inspects structure only; it does not copy message text beyond what
 * validation and normalization require.
 */

import {
  capabilityError,
  responsesError,
  statusForResponsesError,
  type ResponsesErrorEnvelope,
} from './errors.js';

/** Reasoning-effort levels accepted on the Responses surface. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

const REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
]);

/**
 * Hosted (provider-executed) tool types. These are recognized here so the
 * routing layer can pass them through only to an OpenAI upstream that actually
 * runs them, and reject them everywhere else (FR-RESP-011/012). The `_preview`
 * spellings Codex and the OpenAI SDK still emit are included.
 */
export const HOSTED_TOOL_TYPES: ReadonlySet<string> = new Set([
  'web_search',
  'web_search_preview',
  'file_search',
  'code_interpreter',
  'computer_use',
  'computer_use_preview',
  'image_generation',
]);

/** A single content part within a Responses message input item. */
export interface ResponsesContentPart {
  /** e.g. `input_text`, `input_image`, `input_file`, `output_text`, `refusal`. */
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** A structured Responses input item (normalized discriminated union). */
export type ResponsesInputItem =
  | {
      type: 'message';
      role: 'user' | 'assistant' | 'system' | 'developer';
      content: ResponsesContentPart[];
    }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  /** Reasoning items echoed back from a prior turn; carried through opaquely. */
  | { type: 'reasoning'; raw: Record<string, unknown> };

/** A validated function tool definition (FR-TOOLS-001). */
export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

/** A recognized hosted-tool request, retained for the routing-layer policy. */
export interface ResponsesHostedTool {
  type: string;
  raw: Record<string, unknown>;
}

/** A parsed, validated, normalized Responses request. */
export interface ParsedResponsesRequest {
  model: string;
  /** Input items, always normalized to the array form. */
  input: ResponsesInputItem[];
  /** Top-level system/developer instructions, if supplied. */
  instructions?: string;
  functionTools: ResponsesFunctionTool[];
  hostedTools: ResponsesHostedTool[];
  toolChoice?: unknown;
  reasoningEffort?: ReasoningEffort;
  /** Reasoning summary mode, when the client asked for one. */
  reasoningSummary?: unknown;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
  parallelToolCalls?: boolean;
  temperature?: number;
  topP?: number;
  stream: boolean;
  raw: Record<string, unknown>;
}

export type ResponsesParseResult =
  | { ok: true; request: ParsedResponsesRequest }
  | { ok: false; status: number; error: ResponsesErrorEnvelope };

function invalid(
  message: string,
  param?: string,
): { ok: false; status: number; error: ResponsesErrorEnvelope } {
  return {
    ok: false,
    status: statusForResponsesError('invalid_request_error'),
    error: responsesError('invalid_request_error', message, { param }),
  };
}

function unsupported(
  message: string,
  detail: { param?: string; code?: string } = {},
): { ok: false; status: number; error: ResponsesErrorEnvelope } {
  return {
    ok: false,
    status: statusForResponsesError('invalid_request_error'),
    error: capabilityError(message, detail),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const INPUT_ROLES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'system',
  'developer',
]);

/** Normalize a message item's `content` into an array of content parts. */
function normalizeContent(
  content: unknown,
  path: string,
): { parts: ResponsesContentPart[] } | { error: string } {
  if (typeof content === 'string') {
    return { parts: [{ type: 'input_text', text: content }] };
  }
  if (!Array.isArray(content)) {
    return {
      error: `${path}.content: must be a string or an array of content parts`,
    };
  }
  const parts: ResponsesContentPart[] = [];
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i];
    if (!isObject(part) || typeof part.type !== 'string') {
      return {
        error: `${path}.content.${i}: each content part must have a string "type"`,
      };
    }
    parts.push(part as ResponsesContentPart);
  }
  return { parts };
}

/** Validate and normalize one structured input item. */
function normalizeInputItem(
  item: unknown,
  index: number,
): { item: ResponsesInputItem } | { error: string } {
  const path = `input.${index}`;
  if (!isObject(item)) {
    return { error: `${path}: must be an object` };
  }
  // A bare `{ role, content }` is shorthand for a message item (EasyInputMessage).
  const type =
    typeof item.type === 'string'
      ? item.type
      : item.role !== undefined
        ? 'message'
        : undefined;
  if (type === undefined) {
    return { error: `${path}.type: Field required` };
  }

  switch (type) {
    case 'message': {
      const role = item.role;
      if (typeof role !== 'string' || !INPUT_ROLES.has(role)) {
        return {
          error: `${path}.role: must be one of user, assistant, system, developer`,
        };
      }
      const normalized = normalizeContent(item.content, path);
      if ('error' in normalized) {
        return { error: normalized.error };
      }
      return {
        item: {
          type: 'message',
          role: role as 'user' | 'assistant' | 'system' | 'developer',
          content: normalized.parts,
        },
      };
    }
    case 'function_call': {
      if (typeof item.call_id !== 'string' || item.call_id.length === 0) {
        return { error: `${path}.call_id: Field required` };
      }
      if (typeof item.name !== 'string' || item.name.length === 0) {
        return { error: `${path}.name: Field required` };
      }
      const args =
        typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments ?? {});
      return {
        item: {
          type: 'function_call',
          call_id: item.call_id,
          name: item.name,
          arguments: args,
        },
      };
    }
    case 'function_call_output': {
      if (typeof item.call_id !== 'string' || item.call_id.length === 0) {
        return { error: `${path}.call_id: Field required` };
      }
      if (item.output === undefined) {
        return { error: `${path}.output: Field required` };
      }
      const output =
        typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output);
      return {
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output,
        },
      };
    }
    case 'reasoning':
      return { item: { type: 'reasoning', raw: item } };
    default:
      return { error: `${path}.type: unsupported input item type "${type}"` };
  }
}

/** Validate and classify the `tools` array into function and hosted tools. */
function normalizeTools(tools: unknown):
  | {
      functionTools: ResponsesFunctionTool[];
      hostedTools: ResponsesHostedTool[];
    }
  | { error: string } {
  const functionTools: ResponsesFunctionTool[] = [];
  const hostedTools: ResponsesHostedTool[] = [];
  if (tools === undefined) {
    return { functionTools, hostedTools };
  }
  if (!Array.isArray(tools)) {
    return { error: 'tools: must be an array' };
  }
  for (let i = 0; i < tools.length; i += 1) {
    const tool = tools[i];
    if (!isObject(tool) || typeof tool.type !== 'string') {
      return { error: `tools.${i}: each tool must have a string "type"` };
    }
    if (tool.type === 'function') {
      if (typeof tool.name !== 'string' || tool.name.length === 0) {
        return { error: `tools.${i}.name: Field required for function tools` };
      }
      functionTools.push({
        type: 'function',
        name: tool.name,
        description:
          typeof tool.description === 'string' ? tool.description : undefined,
        parameters: tool.parameters,
        strict: typeof tool.strict === 'boolean' ? tool.strict : undefined,
      });
    } else if (HOSTED_TOOL_TYPES.has(tool.type)) {
      hostedTools.push({ type: tool.type, raw: tool });
    } else {
      return { error: `tools.${i}.type: unsupported tool type "${tool.type}"` };
    }
  }
  return { functionTools, hostedTools };
}

/** Parse the top-level `reasoning` object, returning its effort/summary. */
function normalizeReasoning(
  reasoning: unknown,
): { effort?: ReasoningEffort; summary?: unknown } | { error: string } {
  if (reasoning === undefined) {
    return {};
  }
  if (!isObject(reasoning)) {
    return { error: 'reasoning: must be an object' };
  }
  let effort: ReasoningEffort | undefined;
  if (reasoning.effort !== undefined) {
    if (
      typeof reasoning.effort !== 'string' ||
      !REASONING_EFFORTS.has(reasoning.effort)
    ) {
      return {
        error: 'reasoning.effort: must be one of minimal, low, medium, high',
      };
    }
    effort = reasoning.effort as ReasoningEffort;
  }
  return { effort, summary: reasoning.summary };
}

/**
 * Parse and validate a Responses request body (string or already-parsed value).
 */
export function parseResponsesRequest(
  rawBody: string | unknown,
): ResponsesParseResult {
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

  // The gateway holds no response state, so a prior response cannot be resumed.
  if (body.previous_response_id !== undefined) {
    return unsupported(
      'previous_response_id is not supported: this gateway stores no response ' +
        'state. Resend the full conversation as input items.',
      { param: 'previous_response_id', code: 'unsupported_previous_response' },
    );
  }

  // Normalize input: a string is shorthand for a single user message.
  const input: ResponsesInputItem[] = [];
  if (typeof body.input === 'string') {
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: body.input }],
    });
  } else if (Array.isArray(body.input)) {
    if (body.input.length === 0) {
      return invalid('input: must be a non-empty array', 'input');
    }
    for (let i = 0; i < body.input.length; i += 1) {
      const result = normalizeInputItem(body.input[i], i);
      if ('error' in result) {
        return invalid(result.error, 'input');
      }
      input.push(result.item);
    }
  } else {
    return invalid(
      'input: Field required and must be a string or an array of input items',
      'input',
    );
  }

  if (
    body.instructions !== undefined &&
    typeof body.instructions !== 'string'
  ) {
    return invalid('instructions: must be a string', 'instructions');
  }

  const tools = normalizeTools(body.tools);
  if ('error' in tools) {
    return invalid(tools.error, 'tools');
  }

  const reasoning = normalizeReasoning(body.reasoning);
  if ('error' in reasoning) {
    return invalid(reasoning.error, 'reasoning');
  }

  if (body.max_output_tokens !== undefined) {
    if (
      typeof body.max_output_tokens !== 'number' ||
      !Number.isInteger(body.max_output_tokens) ||
      body.max_output_tokens <= 0
    ) {
      return invalid(
        'max_output_tokens: must be a positive integer',
        'max_output_tokens',
      );
    }
  }

  if (body.metadata !== undefined && !isObject(body.metadata)) {
    return invalid('metadata: must be an object', 'metadata');
  }

  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return invalid('stream: must be a boolean', 'stream');
  }

  if (
    body.parallel_tool_calls !== undefined &&
    typeof body.parallel_tool_calls !== 'boolean'
  ) {
    return invalid(
      'parallel_tool_calls: must be a boolean',
      'parallel_tool_calls',
    );
  }

  return {
    ok: true,
    request: {
      model: body.model,
      input,
      instructions:
        typeof body.instructions === 'string' ? body.instructions : undefined,
      functionTools: tools.functionTools,
      hostedTools: tools.hostedTools,
      toolChoice: body.tool_choice,
      reasoningEffort: reasoning.effort,
      reasoningSummary: reasoning.summary,
      maxOutputTokens:
        typeof body.max_output_tokens === 'number'
          ? body.max_output_tokens
          : undefined,
      metadata: isObject(body.metadata) ? body.metadata : undefined,
      parallelToolCalls:
        typeof body.parallel_tool_calls === 'boolean'
          ? body.parallel_tool_calls
          : undefined,
      temperature:
        typeof body.temperature === 'number' ? body.temperature : undefined,
      topP: typeof body.top_p === 'number' ? body.top_p : undefined,
      stream: body.stream === true,
      raw: body,
    },
  };
}
