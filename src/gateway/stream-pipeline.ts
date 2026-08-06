/**
 * Incremental stream pipelines (Task 17, subtasks 17.4-17.6).
 *
 * Composes the four pieces that turn an upstream byte stream into a client SSE
 * stream in a different protocol:
 *
 *   upstream chunks -> {@link sseFrames} -> adapter.parseStreamEvent
 *     -> decode -> translate -> client encoder -> client chunks
 *
 * Each stage is incremental, so a client event is written the moment the
 * upstream delta that implies it arrives. Nothing here buffers a transcript.
 *
 * A stream that ends without its terminator (a dropped connection, an upstream
 * error frame) is closed off rather than left dangling: the translators emit the
 * terminal event from `end()`, so the client always sees a well-formed stream.
 * Because bytes have already been written by then, an error cannot be turned
 * back into an error status -- post-stream retry is forbidden.
 *
 * Every pipeline reports usage through `onComplete` when the stream ends, which
 * is the only point at which a streaming request's token counts exist: they
 * arrive in the upstream's trailing frames, long after the response status was
 * committed. {@link observeVerbatimStream} does the same for pass-through
 * streams, which have no translator to accumulate them.
 */

import type {
  ProviderAdapter,
  StreamEvent,
  UpstreamProtocol,
} from '../providers/types.js';
import {
  AnthropicSseEncoder,
  ChatToAnthropicTranslator,
  decodeAnthropicStreamEvent,
  type StreamEncoderDeps,
} from '../protocols/anthropic/index.js';
import {
  ChatChunkEncoder,
  AnthropicToChatTranslator,
  decodeChatStreamEvent,
  type ChatStreamEncoderDeps,
} from '../protocols/openai-chat/index.js';
import {
  ResponsesSseEncoder,
  ChatToResponsesTranslator,
  type ResponsesStreamEncoderDeps,
} from '../protocols/openai-responses/index.js';
import { sseFrames, SseFrameSplitter } from './sse.js';

/** Token counts an upstream reported over the course of a stream. */
export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

/** Options shared by every translated pipeline. */
export interface TranslatedStreamOptions {
  /** The adapter whose `parseStreamEvent` understands the upstream framing. */
  adapter: ProviderAdapter;
  /** The routed model to stamp on the client stream. */
  model: string;
  /**
   * Called exactly once when the stream ends -- normally, truncated, or
   * abandoned because the client disconnected -- with whatever usage the
   * upstream reported. This is where a streaming request's telemetry comes
   * from: the token counts do not exist until the stream's trailing frames
   * arrive (subtask 17.6).
   */
  onComplete?: (usage: StreamUsage) => void;
}

/**
 * Decode an upstream byte stream into normalized Anthropic stream events.
 *
 * @param chunks The raw upstream body.
 * @param adapter The adapter that parses the upstream's SSE framing.
 */
async function* anthropicEvents(
  chunks: AsyncIterable<string>,
  adapter: ProviderAdapter,
) {
  for await (const frame of sseFrames(chunks)) {
    for (const raw of adapter.parseStreamEvent(frame)) {
      const decoded = decodeAnthropicStreamEvent(raw);
      if (decoded) {
        yield decoded;
      }
    }
  }
}

/**
 * Translate an Anthropic upstream stream into a Chat Completions SSE stream.
 *
 * @param chunks The raw upstream body, chunk by chunk.
 * @param options Adapter, routed model, and completion callback.
 * @param deps Encoder dependencies (id generator, clock).
 * @returns Client-ready SSE text, yielded as each upstream delta arrives.
 */
export async function* anthropicToChatStream(
  chunks: AsyncIterable<string>,
  options: TranslatedStreamOptions,
  deps: ChatStreamEncoderDeps = {},
): AsyncIterable<string> {
  const translator = new AnthropicToChatTranslator(options.model);
  const encoder = new ChatChunkEncoder(deps);
  try {
    for await (const event of anthropicEvents(chunks, options.adapter)) {
      for (const chatEvent of translator.push(event)) {
        yield encoder.encode(chatEvent);
      }
      if (translator.isFinished) {
        break;
      }
    }
    // Terminate a stream the upstream left open (truncated body, error frame).
    for (const chatEvent of translator.end()) {
      yield encoder.encode(chatEvent);
    }
  } finally {
    // In `finally` so a client that disconnects mid-stream still produces a
    // usage event carrying the tokens the upstream had already reported.
    const usage = translator.chatUsage;
    options.onComplete?.({
      inputTokens: usage?.promptTokens,
      outputTokens: usage?.completionTokens,
      cachedTokens: usage?.cachedTokens,
    });
  }
}

/**
 * Decode an upstream byte stream into normalized chat stream events.
 *
 * @param chunks The raw upstream body.
 * @param adapter The adapter that parses the upstream's SSE framing.
 */
async function* chatEvents(
  chunks: AsyncIterable<string>,
  adapter: ProviderAdapter,
) {
  for await (const frame of sseFrames(chunks)) {
    for (const raw of adapter.parseStreamEvent(frame)) {
      yield* decodeChatStreamEvent(raw);
    }
  }
}

/**
 * Translate a Chat Completions upstream stream into an Anthropic Messages SSE
 * stream (subtask 17.5).
 *
 * @param chunks The raw upstream body, chunk by chunk.
 * @param options Adapter, routed model, and completion callback.
 * @param deps Encoder dependencies (message-id generator).
 * @returns Client-ready SSE text, yielded as each upstream delta arrives.
 */
export async function* chatToAnthropicStream(
  chunks: AsyncIterable<string>,
  options: TranslatedStreamOptions,
  deps: StreamEncoderDeps = {},
): AsyncIterable<string> {
  const translator = new ChatToAnthropicTranslator(options.model);
  const encoder = new AnthropicSseEncoder(deps);
  try {
    for await (const event of chatEvents(chunks, options.adapter)) {
      for (const anthropicEvent of translator.push(event)) {
        yield encoder.encode(anthropicEvent);
      }
      if (translator.isFinished) {
        break;
      }
    }
    for (const anthropicEvent of translator.end()) {
      yield encoder.encode(anthropicEvent);
    }
  } finally {
    const usage = translator.anthropicUsage;
    options.onComplete?.({
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedTokens: usage?.cacheReadTokens,
    });
  }
}

/**
 * Translate a Chat Completions upstream stream into a Responses SSE stream.
 *
 * @param chunks The raw upstream body, chunk by chunk.
 * @param options Adapter, routed model, and completion callback.
 * @param deps Encoder dependencies (id generator, clock, echoed request fields).
 * @returns Client-ready SSE text, yielded as each upstream delta arrives.
 */
export async function* chatToResponsesStream(
  chunks: AsyncIterable<string>,
  options: TranslatedStreamOptions,
  deps: ResponsesStreamEncoderDeps = {},
): AsyncIterable<string> {
  const translator = new ChatToResponsesTranslator(options.model);
  const encoder = new ResponsesSseEncoder(deps);
  try {
    for await (const event of chatEvents(chunks, options.adapter)) {
      for (const responsesEvent of translator.push(event)) {
        yield encoder.encode(responsesEvent);
      }
      if (translator.isFinished) {
        break;
      }
    }
    for (const responsesEvent of translator.end()) {
      yield encoder.encode(responsesEvent);
    }
  } finally {
    const usage = translator.responsesUsage;
    options.onComplete?.({
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedTokens: usage?.cachedInputTokens,
    });
  }
}

/** Accumulates the usage an upstream reports across a stream's frames. */
interface UsageAccumulator {
  observe(event: StreamEvent): void;
  usage(): StreamUsage;
}

/** Read a nested property off an unknown value without throwing. */
function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Read a numeric value, or undefined when absent or of the wrong type. */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Usage from an Anthropic stream: input and cache counts arrive on
 * `message_start`, the final output count on `message_delta`.
 */
function anthropicUsageAccumulator(): UsageAccumulator {
  const total: StreamUsage = {};
  return {
    observe(event) {
      const decoded = decodeAnthropicStreamEvent(event);
      const usage =
        decoded?.type === 'message_start' || decoded?.type === 'message_delta'
          ? decoded.usage
          : undefined;
      if (!usage) {
        return;
      }
      total.inputTokens = usage.inputTokens ?? total.inputTokens;
      total.outputTokens = usage.outputTokens ?? total.outputTokens;
      total.cachedTokens = usage.cacheReadTokens ?? total.cachedTokens;
    },
    usage: () => total,
  };
}

/** Usage from a chat stream: one trailing, choice-less usage chunk. */
function chatUsageAccumulator(): UsageAccumulator {
  const total: StreamUsage = {};
  return {
    observe(event) {
      for (const decoded of decodeChatStreamEvent(event)) {
        if (decoded.type === 'usage') {
          total.inputTokens = decoded.usage.promptTokens;
          total.outputTokens = decoded.usage.completionTokens;
          total.cachedTokens = decoded.usage.cachedTokens ?? total.cachedTokens;
        }
      }
    },
    usage: () => total,
  };
}

/**
 * Usage from a Responses stream: carried on the response snapshot of the
 * terminal event, so the last one seen wins.
 */
function responsesUsageAccumulator(): UsageAccumulator {
  const total: StreamUsage = {};
  return {
    observe(event) {
      const usage = at(event.data, 'response', 'usage');
      if (usage === undefined) {
        return;
      }
      total.inputTokens =
        numberOrUndefined(at(usage, 'input_tokens')) ?? total.inputTokens;
      total.outputTokens =
        numberOrUndefined(at(usage, 'output_tokens')) ?? total.outputTokens;
      total.cachedTokens =
        numberOrUndefined(at(usage, 'input_tokens_details', 'cached_tokens')) ??
        total.cachedTokens;
    },
    usage: () => total,
  };
}

/** Pick the accumulator that understands a given upstream wire format. */
function accumulatorFor(protocol: UpstreamProtocol): UsageAccumulator {
  switch (protocol) {
    case 'anthropic':
      return anthropicUsageAccumulator();
    case 'openai_responses':
      return responsesUsageAccumulator();
    default:
      return chatUsageAccumulator();
  }
}

/**
 * Forward a verbatim stream unchanged while reading the usage it reports
 * (subtask 17.6).
 *
 * A verbatim path has no translator to accumulate tokens, but a streaming
 * request's usage event still needs them. This observes the frames in passing
 * and yields the ORIGINAL chunks, so the bytes the client receives stay
 * byte-identical to the upstream's -- the reframing is for reading only.
 *
 * @param chunks The raw upstream body, chunk by chunk.
 * @param options Adapter, upstream protocol, and completion callback.
 * @returns The same chunks, unaltered.
 */
export async function* observeVerbatimStream(
  chunks: AsyncIterable<string>,
  options: {
    adapter: ProviderAdapter;
    protocol: UpstreamProtocol;
    onComplete?: (usage: StreamUsage) => void;
  },
): AsyncIterable<string> {
  const accumulator = accumulatorFor(options.protocol);
  const splitter = new SseFrameSplitter();
  const read = (frames: string[]): void => {
    for (const frame of frames) {
      for (const event of options.adapter.parseStreamEvent(frame)) {
        accumulator.observe(event);
      }
    }
  };
  try {
    for await (const chunk of chunks) {
      read(splitter.push(chunk));
      yield chunk;
    }
    read(splitter.flush());
  } finally {
    // In `finally` so a client disconnect still reports the tokens seen so far.
    options.onComplete?.(accumulator.usage());
  }
}
