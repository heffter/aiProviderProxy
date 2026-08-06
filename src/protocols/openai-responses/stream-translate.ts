/**
 * Incremental Chat -> Responses stream translation (Task 17, subtask 17.4).
 *
 * The streaming counterpart of `chatResponseToCanonical` + `streamEventsForResult`:
 * instead of waiting for a complete `chat.completion` and expanding it, this
 * consumes decoded chat upstream events one at a time and emits the Responses
 * events they imply, so output text reaches the client as the upstream produces
 * it.
 *
 * The shape mismatch that drives the state machine: a chat stream is a flat
 * sequence of deltas with no item boundaries, while Responses requires every
 * delta to sit inside an explicitly opened output item. The translator therefore
 * opens a message item lazily on the first text delta, and closes it when the
 * stream moves on to a tool call or ends.
 *
 * Reasoning deltas are dropped: they have no Responses output item here, and
 * emitting them as message text would put the model's private reasoning into
 * the client's visible output.
 */

import type { ChatUpstreamEvent } from '../openai-chat/stream-decoder.js';
import type { CanonicalChatUsage } from '../openai-chat/response.js';
import type { CanonicalResponseUsage, ResponseStatus } from './response.js';
import type { ResponsesStreamEvent } from './stream-encoder.js';

/** Map chat usage onto the Responses usage shape. */
function toResponsesUsage(
  usage: CanonicalChatUsage | undefined,
): CanonicalResponseUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    ...(usage.cachedTokens !== undefined
      ? { cachedInputTokens: usage.cachedTokens }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
  };
}

/** Map a chat finish_reason onto a Responses terminal status. */
function toStatus(reason: string | undefined): ResponseStatus {
  return reason === 'length' || reason === 'content_filter'
    ? 'incomplete'
    : 'completed';
}

/**
 * A stateful translator from a chat upstream stream to Responses events.
 *
 * Feed it decoded upstream events with {@link push}; each call returns the
 * Responses events implied by that one upstream event. One translator handles
 * one stream.
 */
export class ChatToResponsesTranslator {
  private readonly model: string;
  private started = false;
  private finished = false;
  /** The output item currently open, if any. */
  private openItem: 'message' | 'function_call' | null = null;
  private usage: CanonicalChatUsage | undefined;
  private finishReason: string | undefined;

  constructor(model: string) {
    this.model = model;
  }

  /** True once a terminal `response_done` has been produced. */
  get isFinished(): boolean {
    return this.finished;
  }

  /** Usage reported by the upstream, in Responses shape. */
  get responsesUsage(): CanonicalResponseUsage | undefined {
    return toResponsesUsage(this.usage);
  }

  /**
   * Translate one upstream event.
   *
   * @param event A decoded chat upstream event.
   * @returns The Responses stream events it implies, in order.
   */
  push(event: ChatUpstreamEvent): ResponsesStreamEvent[] {
    if (this.finished) {
      return [];
    }
    switch (event.type) {
      case 'start':
        return this.open();
      case 'text_delta':
        return [
          ...this.open(),
          ...this.openMessage(),
          { type: 'output_text', text: event.text },
        ];
      case 'tool_call_start': {
        const opening = this.open();
        // A new call ends whatever item preceded it.
        const closing = this.closeItem();
        this.openItem = 'function_call';
        return [
          ...opening,
          ...closing,
          {
            type: 'output_item_start',
            item: {
              kind: 'function_call',
              callId: event.id,
              name: event.name,
            },
          },
        ];
      }
      case 'tool_args_delta':
        // Arguments for an item that never opened would make the encoder throw.
        return this.openItem === 'function_call'
          ? [{ type: 'function_arguments', delta: event.delta }]
          : [];
      case 'finish':
        this.finishReason = event.reason ?? this.finishReason;
        return [];
      case 'usage':
        this.usage = event.usage;
        return [];
      case 'done':
        return this.finish(toStatus(this.finishReason));
      case 'reasoning_delta':
        // No Responses output item for private reasoning; see the module note.
        return [];
    }
  }

  /**
   * Close the stream, emitting the terminal event if the upstream never sent
   * `[DONE]`. A stream cut short before any finish reason is reported as
   * `incomplete`, which is what a Responses client expects for a truncated
   * generation.
   */
  end(): ResponsesStreamEvent[] {
    if (this.finished) {
      return [];
    }
    return this.finish(
      this.finishReason === undefined
        ? 'incomplete'
        : toStatus(this.finishReason),
    );
  }

  /** Emit `response_created` exactly once, lazily. */
  private open(): ResponsesStreamEvent[] {
    if (this.started) {
      return [];
    }
    this.started = true;
    return [{ type: 'response_created', model: this.model }];
  }

  /** Open a message item on the first text delta of a run. */
  private openMessage(): ResponsesStreamEvent[] {
    if (this.openItem === 'message') {
      return [];
    }
    const closing = this.closeItem();
    this.openItem = 'message';
    return [
      ...closing,
      { type: 'output_item_start', item: { kind: 'message' } },
    ];
  }

  /** Close the open item, if any. */
  private closeItem(): ResponsesStreamEvent[] {
    if (this.openItem === null) {
      return [];
    }
    this.openItem = null;
    return [{ type: 'output_item_stop' }];
  }

  /** Emit the terminal event, closing any item the upstream left open. */
  private finish(status: ResponseStatus): ResponsesStreamEvent[] {
    const opening = this.open();
    const closing = this.closeItem();
    this.finished = true;
    return [
      ...opening,
      ...closing,
      {
        type: 'response_done',
        status,
        ...(this.responsesUsage ? { usage: this.responsesUsage } : {}),
        ...(status === 'incomplete'
          ? {
              incompleteReason:
                this.finishReason === 'length'
                  ? 'max_output_tokens'
                  : (this.finishReason ?? 'upstream_stream_ended'),
            }
          : {}),
      },
    ];
  }
}
