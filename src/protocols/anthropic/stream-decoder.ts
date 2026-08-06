/**
 * Anthropic upstream SSE decoder (Task 17, subtask 17.4).
 *
 * The inverse of {@link AnthropicSseEncoder}: it reads the events an Anthropic
 * *upstream* emits and normalizes them into a small, typed vocabulary that the
 * client-surface translators consume. Keeping this separate from the per-surface
 * translators means the wire-shape knowledge (where `stop_reason` lives, which
 * delta types exist, how usage is split between `message_start` and
 * `message_delta`) is written down exactly once.
 *
 * Every decoder is total: an event it does not recognize -- a `ping`, a future
 * event type, a malformed payload -- decodes to `undefined` and is skipped by
 * the caller rather than aborting a stream that is otherwise fine.
 */

import type { StreamEvent } from '../../providers/types.js';
import type { CanonicalStreamUsage } from './stream-encoder.js';

/** The kind of content block an upstream opened. */
export type UpstreamBlockInit =
  | { kind: 'text' }
  | { kind: 'tool_use'; id: string; name: string }
  | { kind: 'thinking' };

/** A decoded Anthropic upstream stream event. */
export type AnthropicUpstreamEvent =
  | {
      type: 'message_start';
      id?: string;
      model?: string;
      usage?: CanonicalStreamUsage;
    }
  | { type: 'block_start'; index: number; block: UpstreamBlockInit }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'json_delta'; index: number; partial: string }
  | { type: 'thinking_delta'; index: number; text: string }
  | { type: 'signature_delta'; index: number; signature: string }
  | { type: 'block_stop'; index: number }
  | {
      type: 'message_delta';
      stopReason?: string;
      usage?: CanonicalStreamUsage;
    }
  | { type: 'message_stop' }
  | { type: 'error'; message: string };

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

/** Decode an Anthropic `usage` object; undefined when it carries nothing. */
function decodeUsage(usage: unknown): CanonicalStreamUsage | undefined {
  if (typeof usage !== 'object' || usage === null) {
    return undefined;
  }
  const decoded: CanonicalStreamUsage = {
    inputTokens: num(usage, 'input_tokens'),
    outputTokens: num(usage, 'output_tokens'),
    cacheReadTokens: num(usage, 'cache_read_input_tokens'),
    cacheWriteTokens: num(usage, 'cache_creation_input_tokens'),
  };
  return Object.values(decoded).some((v) => v !== undefined)
    ? decoded
    : undefined;
}

/** Decode the `content_block` of a `content_block_start` event. */
function decodeBlock(block: unknown): UpstreamBlockInit | undefined {
  switch (str(block, 'type')) {
    case 'text':
      return { kind: 'text' };
    case 'thinking':
    case 'redacted_thinking':
      return { kind: 'thinking' };
    case 'tool_use':
      return {
        kind: 'tool_use',
        id: str(block, 'id') ?? '',
        name: str(block, 'name') ?? '',
      };
    default:
      return undefined;
  }
}

/** Decode a `content_block_delta` payload into its typed delta event. */
function decodeDelta(
  index: number,
  delta: unknown,
): AnthropicUpstreamEvent | undefined {
  switch (str(delta, 'type')) {
    case 'text_delta':
      return { type: 'text_delta', index, text: str(delta, 'text') ?? '' };
    case 'input_json_delta':
      return {
        type: 'json_delta',
        index,
        partial: str(delta, 'partial_json') ?? '',
      };
    case 'thinking_delta':
      return {
        type: 'thinking_delta',
        index,
        text: str(delta, 'thinking') ?? '',
      };
    case 'signature_delta':
      return {
        type: 'signature_delta',
        index,
        signature: str(delta, 'signature') ?? '',
      };
    default:
      return undefined;
  }
}

/**
 * Decode one parsed upstream SSE event.
 *
 * @param event An event produced by `ProviderAdapter.parseStreamEvent`.
 * @returns The normalized event, or undefined when it carries nothing the
 *   client surfaces need (a `ping`, an unknown type, a malformed payload).
 */
export function decodeAnthropicStreamEvent(
  event: StreamEvent,
): AnthropicUpstreamEvent | undefined {
  const data = event.data;
  // Prefer the payload's own `type`; the `event:` line is a duplicate of it,
  // but some upstreams omit one or the other.
  const type = str(data, 'type') ?? event.event;
  switch (type) {
    case 'message_start': {
      const message = prop(data, 'message');
      return {
        type: 'message_start',
        id: str(message, 'id'),
        model: str(message, 'model'),
        usage: decodeUsage(prop(message, 'usage')),
      };
    }
    case 'content_block_start': {
      const block = decodeBlock(prop(data, 'content_block'));
      return block
        ? { type: 'block_start', index: num(data, 'index') ?? 0, block }
        : undefined;
    }
    case 'content_block_delta':
      return decodeDelta(num(data, 'index') ?? 0, prop(data, 'delta'));
    case 'content_block_stop':
      return { type: 'block_stop', index: num(data, 'index') ?? 0 };
    case 'message_delta':
      return {
        type: 'message_delta',
        stopReason: str(prop(data, 'delta'), 'stop_reason'),
        usage: decodeUsage(prop(data, 'usage')),
      };
    case 'message_stop':
      return { type: 'message_stop' };
    case 'error':
      return {
        type: 'error',
        message: str(prop(data, 'error'), 'message') ?? 'upstream stream error',
      };
    default:
      // ping, and anything Anthropic adds later.
      return undefined;
  }
}
