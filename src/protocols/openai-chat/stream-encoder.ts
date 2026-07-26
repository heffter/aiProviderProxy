/**
 * OpenAI Chat Completions SSE chunk encoder (epic AIPP-8, subtask 8.1;
 * FR-CHAT-004, FR-TOOLS-003).
 *
 * Renders a stream of provider-neutral *canonical* stream events as a spec-valid
 * Chat Completions SSE sequence of `chat.completion.chunk` records:
 *
 *   data: {chunk with delta.role}          (stream opens)
 *   data: {chunk with delta.content}*       (text deltas)
 *   data: {chunk with delta.tool_calls}*    (tool-call id/name then argument deltas)
 *   data: {chunk with finish_reason}        (terminal choice)
 *   data: {chunk with usage, empty choices} (optional, when usage is reported)
 *   data: [DONE]
 *
 * Chat SSE frames carry no `event:` line -- only `data:` -- and terminate with a
 * literal `data: [DONE]`. The encoder is a state machine: one `chatcmpl` id and
 * `created` timestamp are fixed at stream open and repeated on every chunk, tool
 * calls are keyed by index, and the ordering invariants are enforced (open
 * before deltas, single finish, nothing after `[DONE]`). Illegal transitions
 * throw {@link ChatStreamEncoderError} rather than emitting a malformed stream.
 */

import { uuidGen, type IdGen } from '../../lifecycle/index.js';
import {
  chatCompletionId,
  renderChatUsage,
  type CanonicalChatUsage,
} from './response.js';

/** A provider-neutral chat stream event. */
export type ChatStreamEvent =
  | { type: 'start'; model: string; id?: string }
  /** Assistant text delta. */
  | { type: 'text'; text: string }
  /** Open a tool call at `index` with its id and name. */
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  /** Partial-arguments delta for the tool call at `index`. */
  | { type: 'tool_args'; index: number; delta: string }
  | { type: 'finish'; reason: string; usage?: CanonicalChatUsage };

/** Thrown when a canonical event violates the Chat stream ordering rules. */
export class ChatStreamEncoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatStreamEncoderError';
  }
}

/** Dependencies for {@link ChatChunkEncoder}. */
export interface ChatStreamEncoderDeps {
  genId?: IdGen;
  now?: () => number;
}

/**
 * A stateful encoder. Feed it canonical events with {@link encode}; each call
 * returns the SSE record(s) for that event. One encoder encodes one completion.
 */
export class ChatChunkEncoder {
  private readonly genId: IdGen;
  private readonly nowMs: number;
  private started = false;
  private finished = false;
  private done = false;
  private id = '';
  private model = '';
  private created = 0;

  constructor(deps: ChatStreamEncoderDeps = {}) {
    this.genId = deps.genId ?? uuidGen;
    this.nowMs = deps.now ? deps.now() : Date.now();
  }

  /** True once the terminal `data: [DONE]` has been emitted. */
  get isDone(): boolean {
    return this.done;
  }

  /** Encode one canonical event into its SSE record(s). */
  encode(event: ChatStreamEvent): string {
    if (this.done) {
      throw new ChatStreamEncoderError(
        `no events may follow [DONE] (got "${event.type}")`,
      );
    }
    switch (event.type) {
      case 'start':
        return this.onStart(event);
      case 'text':
        return this.onText(event.text);
      case 'tool_call_start':
        return this.onToolCallStart(event);
      case 'tool_args':
        return this.onToolArgs(event);
      case 'finish':
        return this.onFinish(event);
      default: {
        const exhaustive: never = event;
        throw new ChatStreamEncoderError(
          `unknown event ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  private requireStarted(what: string): void {
    if (!this.started) {
      throw new ChatStreamEncoderError(`${what} before stream start`);
    }
    if (this.finished) {
      throw new ChatStreamEncoderError(`${what} after finish`);
    }
  }

  private onStart(event: Extract<ChatStreamEvent, { type: 'start' }>): string {
    if (this.started) {
      throw new ChatStreamEncoderError('stream started more than once');
    }
    this.started = true;
    this.model = event.model;
    this.id = event.id ?? chatCompletionId(this.genId);
    this.created = Math.floor(this.nowMs / 1000);
    return this.chunk({ role: 'assistant' }, null);
  }

  private onText(text: string): string {
    this.requireStarted('text delta');
    return this.chunk({ content: text }, null);
  }

  private onToolCallStart(
    event: Extract<ChatStreamEvent, { type: 'tool_call_start' }>,
  ): string {
    this.requireStarted('tool_call_start');
    return this.chunk(
      {
        tool_calls: [
          {
            index: event.index,
            id: event.id,
            type: 'function',
            function: { name: event.name, arguments: '' },
          },
        ],
      },
      null,
    );
  }

  private onToolArgs(
    event: Extract<ChatStreamEvent, { type: 'tool_args' }>,
  ): string {
    this.requireStarted('tool_args');
    return this.chunk(
      {
        tool_calls: [
          { index: event.index, function: { arguments: event.delta } },
        ],
      },
      null,
    );
  }

  private onFinish(
    event: Extract<ChatStreamEvent, { type: 'finish' }>,
  ): string {
    this.requireStarted('finish');
    this.finished = true;
    let out = this.chunk({}, event.reason);
    if (event.usage) {
      // A usage-bearing trailer chunk with no choices, then the terminator.
      out += frame({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [],
        usage: renderChatUsage(event.usage),
      });
    }
    out += 'data: [DONE]\n\n';
    this.done = true;
    return out;
  }

  /** Frame one `chat.completion.chunk` with a single choice. */
  private chunk(
    delta: Record<string, unknown>,
    finishReason: string | null,
  ): string {
    return frame({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  }
}

/** Frame one SSE record: a single `data:` line and a blank-line terminator. */
function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Encode a full canonical event script into a single Chat SSE transcript.
 * Enforces every invariant of {@link ChatChunkEncoder} and additionally requires
 * the script to terminate with a `finish` event.
 */
export function encodeChatStream(
  events: Iterable<ChatStreamEvent>,
  deps: ChatStreamEncoderDeps = {},
): string {
  const encoder = new ChatChunkEncoder(deps);
  let out = '';
  for (const event of events) {
    out += encoder.encode(event);
  }
  if (!encoder.isDone) {
    throw new ChatStreamEncoderError('stream did not terminate with finish');
  }
  return out;
}
