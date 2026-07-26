/**
 * OpenAI Responses <-> Chat Completions translation and reasoning controls
 * (epic AIPP-7, subtask 7.5; FR-RESP-008/013/017, FR-TOOLS-002).
 *
 * When a Responses request is routed to a chat-protocol upstream (a provider
 * that does not natively speak the Responses protocol), the surface translates
 * the request to Chat Completions and reconstructs a canonical result from the
 * chat completion, capability-gated per the routed model:
 *
 *   - Input items become chat messages (messages, prior function calls, and
 *     function-call outputs); call ids are preserved verbatim (FR-TOOLS-002).
 *   - `reasoning.effort` maps to `reasoning_effort` for OpenAI-style chat
 *     upstreams, and additionally to the GLM `thinking` control for Z.ai, only
 *     when the routed model declares the reasoning capability. Reasoning text is
 *     never fabricated and never exported; only structured counters and any
 *     upstream-provided summary are surfaced.
 *   - Cached-input and reasoning token counters are extracted into the canonical
 *     usage (FR-RESP-008/013).
 */

import type {
  ParsedResponsesRequest,
  ResponsesContentPart,
  ResponsesInputItem,
} from './request.js';
import type {
  CanonicalOutput,
  CanonicalResponseResult,
  CanonicalResponseUsage,
  ResponseStatus,
} from './response.js';
import {
  gateParallelToolCalls,
  responsesFunctionToolsToChat,
  responsesToolChoiceToChat,
  type ChatFunctionTool,
} from './tools.js';

/** A Chat Completions message (subset produced/consumed by translation). */
export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A Chat Completions request body (subset produced by translation). */
export interface ChatCompletionsBody {
  model: string;
  messages: OpenAIChatMessage[];
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: ChatFunctionTool[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  thinking?: { type: string };
}

/** Options controlling capability-gated translation. */
export interface ResponsesTranslateOptions {
  /** Canonical provider id the request is routed to (e.g. `zai`, `deepseek`). */
  provider: string;
  /** Whether the routed model declares the reasoning capability. */
  reasoningCapable: boolean;
  /** Whether the routed model supports (parallel) tool calls. */
  toolsCapable: boolean;
}

const CONTENT_TEXT_TYPES: ReadonlySet<string> = new Set([
  'input_text',
  'output_text',
  'text',
]);

/** Map Responses message content parts to a chat message content value. */
function contentPartsToChat(
  parts: ResponsesContentPart[],
): string | ChatContentPart[] {
  const chatParts: ChatContentPart[] = [];
  for (const part of parts) {
    if (CONTENT_TEXT_TYPES.has(part.type) && typeof part.text === 'string') {
      chatParts.push({ type: 'text', text: part.text });
    } else if (part.type === 'input_image') {
      const url =
        typeof part.image_url === 'string'
          ? part.image_url
          : ((part.image_url as { url?: string } | undefined)?.url ??
            undefined);
      if (url) {
        chatParts.push({ type: 'image_url', image_url: { url } });
      }
    }
  }
  // Collapse a single text part to a plain string (the common chat shape).
  if (chatParts.length === 1 && chatParts[0].type === 'text') {
    return chatParts[0].text ?? '';
  }
  return chatParts;
}

/** Map the Responses message role to the chat role (developer -> system). */
function chatRole(
  role: 'user' | 'assistant' | 'system' | 'developer',
): 'system' | 'user' | 'assistant' {
  return role === 'developer' ? 'system' : role;
}

/** Translate one Responses input item into zero or more chat messages. */
function inputItemToChat(item: ResponsesInputItem): OpenAIChatMessage[] {
  switch (item.type) {
    case 'message':
      return [
        {
          role: chatRole(item.role),
          content: contentPartsToChat(item.content),
        },
      ];
    case 'function_call':
      return [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: item.call_id,
              type: 'function',
              function: { name: item.name, arguments: item.arguments },
            },
          ],
        },
      ];
    case 'function_call_output':
      return [
        { role: 'tool', tool_call_id: item.call_id, content: item.output },
      ];
    case 'reasoning':
      // Prior-turn reasoning items are never replayed to a chat upstream.
      return [];
  }
}

/**
 * Map reasoning controls onto a chat request, capability-gated. Returns the
 * fields to merge: `reasoning_effort` for OpenAI-style chat upstreams, plus the
 * GLM `thinking` control when routed to Z.ai. Empty when the client asked for no
 * reasoning or the model is not reasoning-capable.
 */
export function mapReasoningControls(
  effort: string | undefined,
  options: { provider: string; reasoningCapable: boolean },
): { reasoning_effort?: string; thinking?: { type: string } } {
  if (effort === undefined || !options.reasoningCapable) {
    return {};
  }
  if (options.provider === 'zai') {
    return { reasoning_effort: effort, thinking: { type: 'enabled' } };
  }
  return { reasoning_effort: effort };
}

/** Translate a parsed Responses request to a Chat Completions body. */
export function responsesToChatBody(
  request: ParsedResponsesRequest,
  model: string,
  options: ResponsesTranslateOptions,
): ChatCompletionsBody {
  const messages: OpenAIChatMessage[] = [];
  if (request.instructions) {
    messages.push({ role: 'system', content: request.instructions });
  }
  for (const item of request.input) {
    messages.push(...inputItemToChat(item));
  }

  const body: ChatCompletionsBody = {
    model,
    messages,
    stream: request.stream,
  };
  if (request.maxOutputTokens !== undefined) {
    body.max_tokens = request.maxOutputTokens;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.topP !== undefined) {
    body.top_p = request.topP;
  }
  if (request.functionTools.length > 0) {
    body.tools = responsesFunctionToolsToChat(request.functionTools);
  }
  const toolChoice = responsesToolChoiceToChat(request.toolChoice);
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice;
  }
  const parallel = gateParallelToolCalls(
    request.parallelToolCalls,
    options.toolsCapable,
  );
  if (parallel !== undefined) {
    body.parallel_tool_calls = parallel;
  }
  const reasoning = mapReasoningControls(request.reasoningEffort, {
    provider: options.provider,
    reasoningCapable: options.reasoningCapable,
  });
  if (reasoning.reasoning_effort !== undefined) {
    body.reasoning_effort = reasoning.reasoning_effort;
  }
  if (reasoning.thinking !== undefined) {
    body.thinking = reasoning.thinking;
  }
  return body;
}

/** Map a Chat Completions finish_reason to a canonical Responses status. */
export function finishReasonToStatus(finish: string | undefined): {
  status: ResponseStatus;
  incompleteReason?: string;
} {
  switch (finish) {
    case 'length':
      return { status: 'incomplete', incompleteReason: 'max_output_tokens' };
    case 'content_filter':
      return { status: 'incomplete', incompleteReason: 'content_filter' };
    default:
      return { status: 'completed' };
  }
}

/** Extract canonical usage from a Chat Completions usage object. */
export function chatUsageToCanonical(
  usage: unknown,
): CanonicalResponseUsage | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const u = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cachedInputTokens: u.prompt_tokens_details?.cached_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
  };
}

/**
 * Reconstruct a canonical Responses result from a Chat Completions response
 * body. Text content becomes a message output; tool calls become function-call
 * outputs with their ids preserved. No reasoning text is surfaced.
 */
export function chatResponseToCanonical(
  body: unknown,
  model: string,
): CanonicalResponseResult {
  const b = (body ?? {}) as {
    id?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | null; tool_calls?: ChatToolCall[] };
    }>;
    usage?: unknown;
  };
  const choice = b.choices?.[0];
  const message = choice?.message;
  const outputs: CanonicalOutput[] = [];

  if (typeof message?.content === 'string' && message.content.length > 0) {
    outputs.push({ kind: 'message', text: message.content });
  }
  for (const call of message?.tool_calls ?? []) {
    outputs.push({
      kind: 'function_call',
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }

  const { status, incompleteReason } = finishReasonToStatus(
    choice?.finish_reason,
  );
  return {
    id: b.id,
    model,
    status,
    incompleteReason,
    outputs,
    usage: chatUsageToCanonical(b.usage),
  };
}
