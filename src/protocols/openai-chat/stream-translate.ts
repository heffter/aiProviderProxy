/**
 * Incremental Anthropic -> Chat Completions stream translation (Task 17, 17.4).
 *
 * The streaming counterpart of `anthropicResponseToChat`: instead of waiting for
 * a complete message and expanding it with `streamEventsForChatResult`, this
 * consumes decoded Anthropic upstream events one at a time and emits the chat
 * events they imply, so a token reaches the client as soon as the upstream
 * produces it.
 *
 * Two shape mismatches are handled here:
 *
 * - Anthropic indexes *all* content blocks in one sequence, while Chat indexes
 *   only tool calls. The translator keeps its own tool-call counter.
 * - Anthropic reports output tokens on `message_delta`, one event before
 *   `message_stop`, whereas a chat stream carries usage on the terminal chunk.
 *   Usage is therefore held until the stream ends.
 *
 * Thinking blocks are dropped: the Chat wire format has nowhere to put them.
 * The non-streaming path reports that loss in a response header, which is not
 * available once the headers have been flushed, so a stream simply omits them.
 */

import type { AnthropicUpstreamEvent } from '../anthropic/stream-decoder.js';
import type { CanonicalStreamUsage } from '../anthropic/stream-encoder.js';
import type { ChatStreamEvent } from './stream-encoder.js';
import type { CanonicalChatUsage } from './response.js';
import { anthropicStopToChatFinish } from './translate.js';

/** Map canonical Anthropic stream usage onto the chat usage shape. */
function toChatUsage(
  usage: CanonicalStreamUsage | undefined,
): CanonicalChatUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
    ...(usage.cacheReadTokens !== undefined
      ? { cachedTokens: usage.cacheReadTokens }
      : {}),
  };
}

/**
 * A stateful translator from an Anthropic upstream stream to chat events.
 *
 * Feed it decoded upstream events with {@link push}; each call returns the chat
 * events implied by that one upstream event (often none). One translator
 * handles one stream.
 */
export class AnthropicToChatTranslator {
  /** The routed model to stamp on the opening chunk. */
  private readonly model: string;
  private started = false;
  private finished = false;
  /** Chat tool-call index, counting tool blocks only. */
  private toolIndex = -1;
  /** The kind of the block currently open, so deltas can be routed or dropped. */
  private openBlock: 'text' | 'tool_use' | 'thinking' | null = null;
  /** Usage accumulated across message_start and message_delta. */
  private usage: CanonicalStreamUsage = {};
  private stopReason: string | undefined;

  constructor(model: string) {
    this.model = model;
  }

  /** True once a terminal `finish` event has been produced. */
  get isFinished(): boolean {
    return this.finished;
  }

  /** Usage seen so far, in chat shape. Complete once the stream has ended. */
  get chatUsage(): CanonicalChatUsage | undefined {
    return toChatUsage(this.usage);
  }

  /**
   * Translate one upstream event.
   *
   * @param event A decoded Anthropic upstream event.
   * @returns The chat stream events it implies, in order; empty when the
   *   upstream event has no chat equivalent.
   */
  push(event: AnthropicUpstreamEvent): ChatStreamEvent[] {
    if (this.finished) {
      return [];
    }
    switch (event.type) {
      case 'message_start':
        this.mergeUsage(event.usage);
        return this.open();
      case 'block_start':
        this.openBlock = event.block.kind;
        if (event.block.kind !== 'tool_use') {
          return [];
        }
        this.toolIndex += 1;
        return [
          ...this.open(),
          {
            type: 'tool_call_start',
            index: this.toolIndex,
            id: event.block.id,
            name: event.block.name,
          },
        ];
      case 'text_delta':
        // A zero-length delta would encode an empty chunk for no reason. Unlike
        // the Responses encoder, the chat encoder needs no open item, so a
        // stray delta is still forwarded -- only thinking text is dropped.
        return event.text.length > 0 && this.openBlock !== 'thinking'
          ? [...this.open(), { type: 'text', text: event.text }]
          : [];
      case 'json_delta':
        return this.openBlock === 'tool_use' && this.toolIndex >= 0
          ? [
              ...this.open(),
              {
                type: 'tool_args',
                index: this.toolIndex,
                delta: event.partial,
              },
            ]
          : [];
      case 'block_stop':
        this.openBlock = null;
        return [];
      case 'message_delta':
        this.stopReason = event.stopReason ?? this.stopReason;
        this.mergeUsage(event.usage);
        return [];
      case 'message_stop':
        return this.finish();
      case 'thinking_delta':
      case 'signature_delta':
      case 'error':
        // Thinking has no chat representation; an upstream error arrives after
        // the status is committed, so the stream is simply cut short by the
        // caller rather than rewritten into an error body.
        return [];
    }
  }

  /**
   * Close the stream, emitting the terminal chunk if the upstream never sent
   * `message_stop` (a truncated stream). Returns nothing when already finished.
   */
  end(): ChatStreamEvent[] {
    return this.finished ? [] : this.finish();
  }

  /** Emit the opening chunk exactly once, lazily. */
  private open(): ChatStreamEvent[] {
    if (this.started) {
      return [];
    }
    this.started = true;
    return [{ type: 'start', model: this.model }];
  }

  /** Emit the terminal chunk, opening the stream first if nothing else did. */
  private finish(): ChatStreamEvent[] {
    const opening = this.open();
    this.finished = true;
    return [
      ...opening,
      {
        type: 'finish',
        reason: anthropicStopToChatFinish(this.stopReason),
        ...(this.chatUsage ? { usage: this.chatUsage } : {}),
      },
    ];
  }

  /** Merge a usage report, keeping fields the later event does not restate. */
  private mergeUsage(usage: CanonicalStreamUsage | undefined): void {
    if (!usage) {
      return;
    }
    for (const [key, value] of Object.entries(usage)) {
      if (value !== undefined) {
        this.usage[key as keyof CanonicalStreamUsage] = value as number;
      }
    }
  }
}
