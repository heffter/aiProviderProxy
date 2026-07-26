/**
 * OpenAI Chat <-> Anthropic Messages translation (epic AIPP-8, subtask 8.2;
 * FR-CHAT-001..010, FR-TOOLS-001..004). Fixes two legacy data-loss defects:
 *
 *   1. Cache tokens. Anthropic `cache_read_input_tokens` and the
 *      `cache_creation_input_tokens` split flow into the reconstructed usage
 *      (and, via the adapter, into the canonical usage event). Legacy dropped
 *      them in `convertAnthropicResponse` (standalone-proxy.ts:2464-2468).
 *   2. Thinking. `thinking` / `redacted_thinking` blocks that the Chat protocol
 *      cannot represent produce namespaced diagnostics (counts only, never the
 *      reasoning text) instead of being silently discarded (legacy default case,
 *      standalone-proxy.ts:2484-2608). Reasoning text is never exported.
 *
 * This module owns the Chat-client-to-Anthropic-upstream mapping used when a
 * chat request is routed to an Anthropic model.
 */

import type {
  CanonicalChatResult,
  CanonicalChatUsage,
  CanonicalToolCall,
} from './response.js';
import type { ChatMessage, ParsedChatRequest } from './request.js';

/** Default max_tokens when a chat client omits it (Anthropic requires one). */
const DEFAULT_MAX_TOKENS = 4096;

/** An Anthropic content block (only `type` is structurally required). */
interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

/** An Anthropic Messages request body (subset produced by translation). */
export interface AnthropicMessagesBody {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>;
  system?: string;
  stream: boolean;
  temperature?: number;
  top_p?: number;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type: string; name?: string };
}

/** A namespaced diagnostic for content the Chat protocol cannot carry. */
export interface ChatTranslationDiagnostic {
  /** Stable namespace, e.g. `anthropic.thinking`. */
  namespace: string;
  /** What was affected, e.g. `thinking`, `redacted_thinking`. */
  kind: string;
  /** How many blocks/events of this kind were seen. */
  count: number;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type?: string; text?: string } =>
          p !== null && typeof p === 'object',
      )
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
  }
  return '';
}

/** Translate one chat message into Anthropic content blocks (or a system note). */
function chatMessageToAnthropic(
  message: ChatMessage,
): { role: 'user' | 'assistant'; content: AnthropicBlock[] } | null {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        content: [{ type: 'text', text: messageText(message.content) }],
      };
    case 'assistant': {
      const blocks: AnthropicBlock[] = [];
      const text = messageText(message.content);
      if (text.length > 0) {
        blocks.push({ type: 'text', text });
      }
      for (const call of message.tool_calls ?? []) {
        const c = call as {
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        let input: unknown = {};
        try {
          input = JSON.parse(c.function?.arguments ?? '{}');
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: String(c.id ?? ''),
          name: String(c.function?.name ?? ''),
          input,
        });
      }
      return { role: 'assistant', content: blocks };
    }
    case 'tool':
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: String(message.tool_call_id ?? ''),
            content: messageText(message.content),
          },
        ],
      };
    default:
      // system / developer are hoisted into the top-level `system` field.
      return null;
  }
}

/** Map a chat tool_choice to the Anthropic tool_choice shape. */
function toolChoiceToAnthropic(
  choice: unknown,
): { type: string; name?: string } | undefined {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return undefined;
  if (choice !== null && typeof choice === 'object') {
    const c = choice as { type?: string; function?: { name?: string } };
    if (c.type === 'function' && c.function?.name) {
      return { type: 'tool', name: c.function.name };
    }
  }
  return undefined;
}

/** Translate a Chat Completions request into an Anthropic Messages body. */
export function chatToAnthropicRequest(
  request: ParsedChatRequest,
  model: string,
): AnthropicMessagesBody {
  const systemParts: string[] = [];
  const messages: AnthropicMessagesBody['messages'] = [];
  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      systemParts.push(messageText(message.content));
      continue;
    }
    const translated = chatMessageToAnthropic(message);
    if (translated) {
      messages.push(translated);
    }
  }

  const body: AnthropicMessagesBody = {
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    stream: request.stream,
  };
  if (systemParts.length > 0) {
    body.system = systemParts.join('\n');
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.topP !== undefined) {
    body.top_p = request.topP;
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools
      .filter(
        (t): t is Record<string, unknown> =>
          t !== null && typeof t === 'object',
      )
      .map((t) => {
        const fn = (t as { function?: Record<string, unknown> }).function ?? {};
        return {
          name: String(fn.name ?? ''),
          ...(typeof fn.description === 'string'
            ? { description: fn.description }
            : {}),
          input_schema: fn.parameters,
        };
      });
  }
  const toolChoice = toolChoiceToAnthropic(request.toolChoice);
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }
  return body;
}

/** Map an Anthropic stop_reason to a Chat finish_reason. */
export function anthropicStopToChatFinish(stop: string | undefined): string {
  switch (stop) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'stop_sequence':
    case 'end_turn':
    default:
      return 'stop';
  }
}

/** Extract Anthropic usage into canonical chat usage, preserving cache tokens. */
export function anthropicUsageToChat(
  usage: unknown,
): CanonicalChatUsage | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const u = usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  return {
    promptTokens: u.input_tokens ?? 0,
    completionTokens: u.output_tokens ?? 0,
    // Fix (1): cache-read tokens are preserved rather than dropped.
    cachedTokens: u.cache_read_input_tokens,
  };
}

/** Collect namespaced diagnostics for thinking blocks the chat wire can't carry. */
export function collectThinkingDiagnostics(
  content: unknown,
): ChatTranslationDiagnostic[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const counts = new Map<string, number>();
  for (const block of content) {
    const type = (block as { type?: unknown }).type;
    if (type === 'thinking' || type === 'redacted_thinking') {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([kind, count]) => ({
    namespace: 'anthropic.thinking',
    kind,
    count,
  }));
}

/** Result of reconstructing a chat completion from an Anthropic response. */
export interface AnthropicToChatResult {
  result: CanonicalChatResult;
  /** Namespaced diagnostics (e.g. dropped thinking blocks); never any text. */
  diagnostics: ChatTranslationDiagnostic[];
}

/**
 * Reconstruct a canonical chat result from an Anthropic Messages response. Text
 * and tool calls map to the assistant choice; thinking blocks are diagnosed, not
 * emitted; cache tokens are preserved in the usage.
 */
export function anthropicResponseToChat(
  body: unknown,
  model: string,
): AnthropicToChatResult {
  const b = (body ?? {}) as {
    id?: string;
    content?: AnthropicBlock[];
    stop_reason?: string;
    usage?: unknown;
  };
  const content = b.content ?? [];
  let text = '';
  const toolCalls: CanonicalToolCall[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }

  const result: CanonicalChatResult = {
    id: b.id,
    model,
    finishReason: anthropicStopToChatFinish(b.stop_reason),
    text: text.length > 0 ? text : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: anthropicUsageToChat(b.usage),
  };
  return { result, diagnostics: collectThinkingDiagnostics(content) };
}
