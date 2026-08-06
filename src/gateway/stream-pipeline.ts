/**
 * Incremental translated-stream pipelines (Task 17, subtask 17.4).
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
 */

import type { ProviderAdapter } from '../providers/types.js';
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
import { sseFrames } from './sse.js';

/** Options shared by every translated pipeline. */
export interface TranslatedStreamOptions {
  /** The adapter whose `parseStreamEvent` understands the upstream framing. */
  adapter: ProviderAdapter;
  /** The routed model to stamp on the client stream. */
  model: string;
  /** Called once the stream ends, with whatever usage the upstream reported. */
  onComplete?: (usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  }) => void;
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
  const usage = translator.chatUsage;
  options.onComplete?.({
    inputTokens: usage?.promptTokens,
    outputTokens: usage?.completionTokens,
    cachedTokens: usage?.cachedTokens,
  });
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
  const usage = translator.anthropicUsage;
  options.onComplete?.({
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cachedTokens: usage?.cacheReadTokens,
  });
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
  const usage = translator.responsesUsage;
  options.onComplete?.({
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cachedTokens: usage?.cachedInputTokens,
  });
}
