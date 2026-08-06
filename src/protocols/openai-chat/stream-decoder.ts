/**
 * OpenAI Chat Completions upstream SSE decoder (Task 17, subtask 17.4).
 *
 * The inverse of {@link ChatChunkEncoder}: it reads the `chat.completion.chunk`
 * records an OpenAI-style *upstream* emits and normalizes them into a typed
 * vocabulary the client-surface translators consume. Written once here so that
 * every surface translating a chat upstream -- Responses (17.4) and Anthropic
 * Messages (17.5) -- shares one reading of the wire format.
 *
 * A single chunk can imply several events: the opening chunk may carry a role
 * and content together, and a tool-call chunk carries the call's identity and
 * its first argument fragment at once. Decoding therefore returns a list.
 *
 * Decoding is total: an unrecognized or malformed chunk yields no events rather
 * than aborting a stream that is otherwise fine.
 */

import type { StreamEvent } from '../../providers/types.js';
import type { CanonicalChatUsage } from './response.js';

/** A decoded chat upstream stream event. */
export type ChatUpstreamEvent =
  /** The stream opened; carries the upstream's ids when it supplied them. */
  | { type: 'start'; id?: string; model?: string }
  | { type: 'text_delta'; text: string }
  /** Reasoning text, which some OpenAI-compatible upstreams stream separately. */
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_args_delta'; index: number; delta: string }
  | { type: 'finish'; reason?: string }
  | { type: 'usage'; usage: CanonicalChatUsage }
  /** The terminal `data: [DONE]` record. */
  | { type: 'done' };

/** Read a property off an unknown value without throwing. */
function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Read a string property, or undefined when absent or of the wrong type. */
function str(value: unknown, key: string): string | undefined {
  const found = prop(value, key);
  return typeof found === 'string' ? found : undefined;
}

/** Read a numeric property, or undefined when absent or of the wrong type. */
function num(value: unknown, key: string): number | undefined {
  const found = prop(value, key);
  return typeof found === 'number' ? found : undefined;
}

/** Decode a chat `usage` object; undefined when it carries no token counts. */
function decodeUsage(usage: unknown): CanonicalChatUsage | undefined {
  const promptTokens = num(usage, 'prompt_tokens');
  const completionTokens = num(usage, 'completion_tokens');
  if (promptTokens === undefined && completionTokens === undefined) {
    return undefined;
  }
  const cached = num(prop(usage, 'prompt_tokens_details'), 'cached_tokens');
  const reasoning = num(
    prop(usage, 'completion_tokens_details'),
    'reasoning_tokens',
  );
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * Decode the `delta.tool_calls` array of one chunk.
 *
 * A fragment that names the call opens it; a fragment carrying only arguments
 * extends the call already open at that index. `index` is the upstream's own
 * tool-call index and is passed through unchanged.
 */
function decodeToolCalls(toolCalls: unknown): ChatUpstreamEvent[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const events: ChatUpstreamEvent[] = [];
  for (const entry of toolCalls) {
    const index = num(entry, 'index') ?? 0;
    const fn = prop(entry, 'function');
    const name = str(fn, 'name');
    const id = str(entry, 'id');
    if (name !== undefined || id !== undefined) {
      events.push({
        type: 'tool_call_start',
        index,
        id: id ?? '',
        name: name ?? '',
      });
    }
    const args = str(fn, 'arguments');
    if (args !== undefined && args.length > 0) {
      events.push({ type: 'tool_args_delta', index, delta: args });
    }
  }
  return events;
}

/**
 * Decode one parsed upstream SSE event into normalized chat events.
 *
 * @param event An event produced by `ProviderAdapter.parseStreamEvent`.
 * @returns The normalized events it implies, in order; empty when the record
 *   carries nothing the client surfaces need.
 */
export function decodeChatStreamEvent(event: StreamEvent): ChatUpstreamEvent[] {
  if (event.event === 'done' || event.data === '[DONE]') {
    return [{ type: 'done' }];
  }
  const data = event.data;
  if (typeof data !== 'object' || data === null) {
    return [];
  }
  const events: ChatUpstreamEvent[] = [];
  const choices = prop(data, 'choices');
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const delta = prop(choice, 'delta');

  // The role marks the opening chunk; ids come from the same record.
  if (str(delta, 'role') !== undefined) {
    events.push({
      type: 'start',
      id: str(data, 'id'),
      model: str(data, 'model'),
    });
  }
  const reasoning =
    str(delta, 'reasoning_content') ?? str(delta, 'reasoning') ?? undefined;
  if (reasoning !== undefined && reasoning.length > 0) {
    events.push({ type: 'reasoning_delta', text: reasoning });
  }
  const content = str(delta, 'content');
  if (content !== undefined && content.length > 0) {
    events.push({ type: 'text_delta', text: content });
  }
  events.push(...decodeToolCalls(prop(delta, 'tool_calls')));

  const finish = str(choice, 'finish_reason');
  if (finish !== undefined) {
    events.push({ type: 'finish', reason: finish });
  }
  // A usage-bearing trailer chunk carries no choices at all.
  const usage = decodeUsage(prop(data, 'usage'));
  if (usage) {
    events.push({ type: 'usage', usage });
  }
  return events;
}
