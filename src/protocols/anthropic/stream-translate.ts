/**
 * Incremental Chat -> Anthropic Messages stream translation (Task 17, 17.5).
 *
 * The streaming counterpart of `openAIResponseToAnthropic`: instead of waiting
 * for a complete `chat.completion` and expanding it with
 * `streamEventsForAnthropicMessage`, this consumes decoded chat upstream events
 * one at a time and emits the Anthropic events they imply, so a Claude-shaped
 * client streaming through an OpenAI-style upstream sees tokens as they are
 * produced.
 *
 * The shape mismatch that drives the state machine: a chat stream is a flat
 * sequence of deltas, while Anthropic requires every delta to sit inside an
 * explicitly opened content block, with blocks opened and closed in order. The
 * translator therefore opens a block lazily on the first delta of each kind and
 * closes it whenever the stream switches to a different kind.
 *
 * Reasoning deltas from OpenAI-compatible upstreams map onto Anthropic thinking
 * blocks, which is the one place a chat stream carries more than the Chat wire
 * format itself can express.
 */

import type {
  ChatUpstreamEvent,
  CanonicalChatUsage,
} from '../openai-chat/index.js';
import type {
  AnthropicStopReason,
  CanonicalStreamEvent,
  CanonicalStreamUsage,
} from './stream-encoder.js';

/** Map a chat finish_reason onto an Anthropic stop_reason. */
function toStopReason(reason: string | undefined): AnthropicStopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/** Map chat usage onto the canonical Anthropic stream usage shape. */
function toAnthropicUsage(
  usage: CanonicalChatUsage | undefined,
): CanonicalStreamUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    ...(usage.cachedTokens !== undefined
      ? { cacheReadTokens: usage.cachedTokens }
      : {}),
  };
}

/** The kind of Anthropic block currently open. */
type OpenBlock = 'text' | 'thinking' | 'tool_use' | null;

/**
 * A stateful translator from a chat upstream stream to Anthropic events.
 *
 * Feed it decoded upstream events with {@link push}; each call returns the
 * Anthropic events implied by that one upstream event. One translator handles
 * one stream.
 */
export class ChatToAnthropicTranslator {
  private readonly model: string;
  private started = false;
  private finished = false;
  private openBlock: OpenBlock = null;
  /** Upstream tool-call index of the open tool_use block, to detect a switch. */
  private openToolIndex: number | undefined;
  private usage: CanonicalChatUsage | undefined;
  private finishReason: string | undefined;

  constructor(model: string) {
    this.model = model;
  }

  /** True once a terminal `message_stop` has been produced. */
  get isFinished(): boolean {
    return this.finished;
  }

  /** Usage reported by the upstream, in canonical Anthropic shape. */
  get anthropicUsage(): CanonicalStreamUsage | undefined {
    return toAnthropicUsage(this.usage);
  }

  /**
   * Translate one upstream event.
   *
   * @param event A decoded chat upstream event.
   * @returns The Anthropic stream events it implies, in order.
   */
  push(event: ChatUpstreamEvent): CanonicalStreamEvent[] {
    if (this.finished) {
      return [];
    }
    switch (event.type) {
      case 'start':
        return this.open();
      case 'text_delta':
        return [
          ...this.open(),
          ...this.openTyped('text'),
          { type: 'text', text: event.text },
        ];
      case 'reasoning_delta':
        return [
          ...this.open(),
          ...this.openTyped('thinking'),
          { type: 'thinking', text: event.text },
        ];
      case 'tool_call_start': {
        const opening = this.open();
        // A different call index means the previous block is finished.
        const closing = this.closeBlock();
        this.openBlock = 'tool_use';
        this.openToolIndex = event.index;
        return [
          ...opening,
          ...closing,
          {
            type: 'block_start',
            block: { kind: 'tool_use', id: event.id, name: event.name },
          },
        ];
      }
      case 'tool_args_delta':
        // A fragment for a block that never opened would make the encoder throw.
        return this.openBlock === 'tool_use' &&
          this.openToolIndex === event.index
          ? [{ type: 'json', partial: event.delta }]
          : [];
      case 'finish':
        this.finishReason = event.reason ?? this.finishReason;
        return [];
      case 'usage':
        this.usage = event.usage;
        return [];
      case 'done':
        return this.finish();
    }
  }

  /**
   * Close the stream, emitting the terminal events if the upstream never sent
   * `[DONE]`. The client always sees a well-formed transcript, even when the
   * upstream connection dropped mid-generation.
   */
  end(): CanonicalStreamEvent[] {
    return this.finished ? [] : this.finish();
  }

  /** Emit `message_start` exactly once, lazily, carrying the input usage. */
  private open(): CanonicalStreamEvent[] {
    if (this.started) {
      return [];
    }
    this.started = true;
    return [
      {
        type: 'message_start',
        model: this.model,
        // Input counts usually arrive in the trailer, after this point; the
        // terminal message_delta restates whatever the upstream reported.
        usage: { ...this.anthropicUsage, outputTokens: 0 },
      },
    ];
  }

  /** Open a block of the given kind, closing a different one first. */
  private openTyped(kind: 'text' | 'thinking'): CanonicalStreamEvent[] {
    if (this.openBlock === kind) {
      return [];
    }
    const closing = this.closeBlock();
    this.openBlock = kind;
    return [...closing, { type: 'block_start', block: { kind } }];
  }

  /** Close the open block, if any. */
  private closeBlock(): CanonicalStreamEvent[] {
    if (this.openBlock === null) {
      return [];
    }
    this.openBlock = null;
    this.openToolIndex = undefined;
    return [{ type: 'block_stop' }];
  }

  /** Emit the terminal events, closing any block the upstream left open. */
  private finish(): CanonicalStreamEvent[] {
    const opening = this.open();
    const closing = this.closeBlock();
    this.finished = true;
    return [
      ...opening,
      ...closing,
      {
        type: 'message_delta',
        stopReason: toStopReason(this.finishReason),
        stopSequence: null,
        ...(this.anthropicUsage ? { usage: this.anthropicUsage } : {}),
      },
      { type: 'message_stop' },
    ];
  }
}
