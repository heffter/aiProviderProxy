/**
 * OpenAI Chat Completions object construction (epic AIPP-8, subtask 8.1;
 * FR-CHAT-001..010).
 *
 * Renders a provider-neutral *canonical chat result* as a spec-valid non-
 * streaming `chat.completion` object: a single assistant choice (text and/or
 * tool calls), a finish reason, and a `usage` block that carries cached-input
 * and reasoning-token detail when the upstream reported them (the cache-token
 * fix lands with subtask 8.2). The canonical result is upstream-agnostic: it is
 * built near-verbatim from an OpenAI/OpenAI-compatible upstream or reconstructed
 * from an Anthropic/Gemini/Ollama upstream (subtasks 8.2-8.4).
 */

import { uuidGen, type IdGen } from '../../lifecycle/index.js';

/** A canonical tool call (stable id preserved through translation). */
export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Canonical chat usage with cached-input and reasoning detail. */
export interface CanonicalChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** Cached input tokens (`prompt_tokens_details.cached_tokens`). */
  cachedTokens?: number;
  /** Reasoning tokens (`completion_tokens_details.reasoning_tokens`). */
  reasoningTokens?: number;
}

/** A provider-neutral chat completion result. */
export interface CanonicalChatResult {
  /** Provider response id, when the upstream supplied one. */
  id?: string;
  model: string;
  /** Creation time in epoch seconds; defaults to now. */
  created?: number;
  finishReason: string;
  text?: string;
  toolCalls?: CanonicalToolCall[];
  usage?: CanonicalChatUsage;
}

/** Dependencies for {@link buildChatCompletion}. */
export interface ChatBuildDeps {
  /** Id generator; defaults to a UUID-backed generator. */
  genId?: IdGen;
  /** Epoch-millis clock; `created` is `floor(now/1000)`. Defaults to Date.now. */
  now?: () => number;
}

/** Mint a `chatcmpl-...` id from an id generator. */
export function chatCompletionId(genId: IdGen): string {
  return `chatcmpl-${genId().replace(/-/g, '')}`;
}

/** Render canonical tool calls into the Chat message `tool_calls` shape. */
export function renderToolCalls(
  calls: CanonicalToolCall[],
): Array<Record<string, unknown>> {
  return calls.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }));
}

/** Render the canonical usage into the Chat Completions usage shape. */
export function renderChatUsage(
  usage: CanonicalChatUsage,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
  };
  if (usage.cachedTokens !== undefined) {
    out.prompt_tokens_details = { cached_tokens: usage.cachedTokens };
  }
  if (usage.reasoningTokens !== undefined) {
    out.completion_tokens_details = {
      reasoning_tokens: usage.reasoningTokens,
    };
  }
  return out;
}

/**
 * Reduce a `chat.completion` object back to a canonical result. Used to serve a
 * streaming client from an upstream that produced a single (translated)
 * completion object -- the object is turned into a canonical result and then
 * re-emitted as a chunk stream.
 */
export function chatCompletionToCanonical(body: unknown): CanonicalChatResult {
  const b = (body ?? {}) as {
    id?: string;
    model?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const choice = b.choices?.[0];
  const message = choice?.message;
  const toolCalls: CanonicalToolCall[] = (message?.tool_calls ?? []).map(
    (call) => ({
      id: String(call.id ?? ''),
      name: String(call.function?.name ?? ''),
      arguments: String(call.function?.arguments ?? ''),
    }),
  );
  const usage: CanonicalChatUsage | undefined = b.usage
    ? {
        promptTokens: b.usage.prompt_tokens ?? 0,
        completionTokens: b.usage.completion_tokens ?? 0,
        cachedTokens: b.usage.prompt_tokens_details?.cached_tokens,
        reasoningTokens: b.usage.completion_tokens_details?.reasoning_tokens,
      }
    : undefined;
  return {
    id: b.id,
    model: String(b.model ?? ''),
    finishReason: choice?.finish_reason ?? 'stop',
    text:
      typeof message?.content === 'string' && message.content.length > 0
        ? message.content
        : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

/** Build a spec-valid non-streaming `chat.completion` object. */
export function buildChatCompletion(
  result: CanonicalChatResult,
  deps: ChatBuildDeps = {},
): Record<string, unknown> {
  const genId = deps.genId ?? uuidGen;
  const nowMs = deps.now ? deps.now() : Date.now();
  const created = result.created ?? Math.floor(nowMs / 1000);

  const message: Record<string, unknown> = { role: 'assistant' };
  if (result.toolCalls && result.toolCalls.length > 0) {
    message.content = result.text ?? null;
    message.tool_calls = renderToolCalls(result.toolCalls);
  } else {
    message.content = result.text ?? '';
  }

  const obj: Record<string, unknown> = {
    id: result.id ?? chatCompletionId(genId),
    object: 'chat.completion',
    created,
    model: result.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.finishReason,
      },
    ],
  };
  if (result.usage) {
    obj.usage = renderChatUsage(result.usage);
  }
  return obj;
}
