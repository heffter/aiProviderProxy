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
  type AnthropicUpstreamEvent,
  type StreamEncoderDeps,
} from '../protocols/anthropic/index.js';
import {
  ChatChunkEncoder,
  AnthropicToChatTranslator,
  decodeChatStreamEvent,
  type ChatStreamEncoderDeps,
  type ChatUpstreamEvent,
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
   * abandoned because the client disconnected. This is where a streaming
   * request's telemetry and history content come from: neither the token counts
   * nor the response body exist until the stream's frames arrive
   * (subtasks 17.6 and 21).
   */
  onComplete?: (result: StreamCompletion) => void;
}

/** What a finished stream reports back to the gateway. */
export interface StreamCompletion {
  usage: StreamUsage;
  /**
   * The assistant response rebuilt from the deltas, for the local history log,
   * or undefined when the stream carried nothing worth recording.
   */
  response?: unknown;
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
  const captured = new ResponseAccumulator();
  try {
    for await (const event of anthropicEvents(chunks, options.adapter)) {
      accumulateAnthropic(captured, event);
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
      usage: {
        inputTokens: usage?.promptTokens,
        outputTokens: usage?.completionTokens,
        cachedTokens: usage?.cachedTokens,
      },
      response: captured.result(),
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
  const captured = new ResponseAccumulator();
  try {
    for await (const event of chatEvents(chunks, options.adapter)) {
      accumulateChat(captured, event);
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
      usage: {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedTokens: usage?.cacheReadTokens,
      },
      response: captured.result(),
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
  const captured = new ResponseAccumulator();
  try {
    for await (const event of chatEvents(chunks, options.adapter)) {
      accumulateChat(captured, event);
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
      usage: {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedTokens: usage?.cachedInputTokens,
      },
      response: captured.result(),
    });
  }
}

/**
 * Accumulates what a verbatim stream reports as its frames pass by: the usage
 * the upstream states, and the assistant response rebuilt for the history log.
 */
interface StreamObserver {
  observe(event: StreamEvent): void;
  usage(): StreamUsage;
  response(): unknown;
}

/**
 * Cap on the assistant text reconstructed for the history log (subtask 21).
 *
 * The point of streaming is not to hold the whole response in memory, so the
 * reconstruction is bounded and marks itself truncated rather than growing with
 * the response. The content buffer applies its own size/depth limits on top.
 */
const MAX_CAPTURED_TEXT = 128 * 1024;

/**
 * Rebuilds the assistant response of a stream for the local history log.
 *
 * Streaming buffers nothing, so `parsedResponse.body` is empty for a streamed
 * request and the history log would otherwise record an empty response. This
 * collects the text (and tool-call shape) as the deltas pass by, which is both
 * far smaller than the raw SSE transcript and more useful to read back.
 */
class ResponseAccumulator {
  private text = '';
  private truncated = false;
  private readonly toolCalls: Array<{ name: string; arguments: string }> = [];

  /** Append an assistant text delta, stopping at the cap. */
  addText(delta: string): void {
    if (this.text.length >= MAX_CAPTURED_TEXT) {
      this.truncated = true;
      return;
    }
    const room = MAX_CAPTURED_TEXT - this.text.length;
    if (delta.length > room) {
      this.text += delta.slice(0, room);
      this.truncated = true;
      return;
    }
    this.text += delta;
  }

  /** Open a tool call; its arguments arrive as later fragments. */
  startToolCall(name: string): void {
    this.toolCalls.push({ name, arguments: '' });
  }

  /** Append an argument fragment to the most recently opened tool call. */
  addToolArgs(delta: string): void {
    const current = this.toolCalls[this.toolCalls.length - 1];
    if (!current || current.arguments.length >= MAX_CAPTURED_TEXT) {
      return;
    }
    current.arguments += delta.slice(
      0,
      MAX_CAPTURED_TEXT - current.arguments.length,
    );
  }

  /**
   * The reconstructed response, or undefined when the stream carried nothing
   * worth recording (so the sink writes a metadata-only history entry, exactly
   * as it does for a failed request).
   */
  result(): unknown {
    if (this.text.length === 0 && this.toolCalls.length === 0) {
      return undefined;
    }
    return {
      streamed: true,
      ...(this.text.length > 0 ? { text: this.text } : {}),
      ...(this.toolCalls.length > 0 ? { tool_calls: this.toolCalls } : {}),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }
}

/** Feed a decoded Anthropic upstream event into the response accumulator. */
function accumulateAnthropic(
  into: ResponseAccumulator,
  event: AnthropicUpstreamEvent,
): void {
  switch (event.type) {
    case 'text_delta':
      into.addText(event.text);
      break;
    case 'block_start':
      if (event.block.kind === 'tool_use') {
        into.startToolCall(event.block.name);
      }
      break;
    case 'json_delta':
      into.addToolArgs(event.partial);
      break;
    default:
      // Thinking and signature deltas are deliberately not recorded.
      break;
  }
}

/** Feed a decoded chat upstream event into the response accumulator. */
function accumulateChat(
  into: ResponseAccumulator,
  event: ChatUpstreamEvent,
): void {
  switch (event.type) {
    case 'text_delta':
      into.addText(event.text);
      break;
    case 'tool_call_start':
      into.startToolCall(event.name);
      break;
    case 'tool_args_delta':
      into.addToolArgs(event.delta);
      break;
    default:
      break;
  }
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
function anthropicUsageAccumulator(): StreamObserver {
  const total: StreamUsage = {};
  const captured = new ResponseAccumulator();
  return {
    observe(event) {
      const decoded = decodeAnthropicStreamEvent(event);
      if (!decoded) {
        return;
      }
      accumulateAnthropic(captured, decoded);
      const usage =
        decoded.type === 'message_start' || decoded.type === 'message_delta'
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
    response: () => captured.result(),
  };
}

/** Usage from a chat stream: one trailing, choice-less usage chunk. */
function chatUsageAccumulator(): StreamObserver {
  const total: StreamUsage = {};
  const captured = new ResponseAccumulator();
  return {
    observe(event) {
      for (const decoded of decodeChatStreamEvent(event)) {
        accumulateChat(captured, decoded);
        if (decoded.type === 'usage') {
          total.inputTokens = decoded.usage.promptTokens;
          total.outputTokens = decoded.usage.completionTokens;
          total.cachedTokens = decoded.usage.cachedTokens ?? total.cachedTokens;
        }
      }
    },
    usage: () => total,
    response: () => captured.result(),
  };
}

/**
 * Usage from a Responses stream: carried on the response snapshot of the
 * terminal event, so the last one seen wins.
 */
function responsesUsageAccumulator(): StreamObserver {
  const total: StreamUsage = {};
  const captured = new ResponseAccumulator();
  return {
    observe(event) {
      // There is no Responses upstream decoder (the surface only ever forwards
      // this protocol verbatim), so the text is read straight off the frame.
      if (event.event === 'response.output_text.delta') {
        const delta = at(event.data, 'delta');
        if (typeof delta === 'string') {
          captured.addText(delta);
        }
      }
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
    response: () => captured.result(),
  };
}

/** Pick the accumulator that understands a given upstream wire format. */
function accumulatorFor(protocol: UpstreamProtocol): StreamObserver {
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
    onComplete?: (result: StreamCompletion) => void;
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
    options.onComplete?.({
      usage: accumulator.usage(),
      response: accumulator.response(),
    });
  }
}
