/**
 * OpenAI Responses SSE state-machine encoder (epic AIPP-7, subtask 7.3;
 * FR-RESP-004/005/009, FR-TOOLS-003).
 *
 * Renders a stream of provider-neutral *canonical* stream events as a spec-valid
 * OpenAI Responses Server-Sent Events sequence:
 *
 *   response.created
 *   response.in_progress
 *     (per output item:)
 *       response.output_item.added
 *       -- message item:
 *          response.content_part.added
 *          response.output_text.delta*
 *          response.output_text.done
 *          response.content_part.done
 *       -- function_call item:
 *          response.function_call_arguments.delta*
 *          response.function_call_arguments.done
 *       response.output_item.done
 *   response.completed | response.failed | response.incomplete
 *
 * The encoder is a state machine: it assigns a monotonic `sequence_number` to
 * every event (from 0), assigns `output_index` per item and `content_index` per
 * message content part, mints stable item ids, frames each event as an
 * `event:`/`data:` SSE record, and enforces the Responses ordering invariants --
 * an item must be open before deltas flow into it, delta kinds must match the
 * open item kind, exactly one terminal event is emitted, and nothing may follow
 * it. Illegal transitions throw {@link ResponsesStreamEncoderError} rather than
 * emitting a malformed transcript.
 *
 * The canonical model is upstream-agnostic (an OpenAI Responses upstream or a
 * Chat Completions upstream both normalize into it); this encoder owns the
 * Responses client-surface wire format only, reusing the item and envelope
 * renderers from {@link ./response.js} so a streamed terminal snapshot is
 * byte-identical to the equivalent non-streaming object.
 */

import { uuidGen, type IdGen } from '../../lifecycle/index.js';
import {
  aggregateOutputText,
  functionCallOutputItem,
  messageOutputItem,
  prefixedId,
  renderResponseEnvelope,
  type CanonicalOutput,
  type CanonicalResponseResult,
  type CanonicalResponseUsage,
  type ResponseSnapshotStatus,
  type ResponseStatus,
  type ResponsesEcho,
  type ResponsesOutputItem,
} from './response.js';

/** The kind of output item being opened. */
export type CanonicalItemInit =
  { kind: 'message' } | { kind: 'function_call'; callId: string; name: string };

/**
 * A provider-neutral stream event. Item lifecycle is explicit: open an item with
 * `output_item_start`, push matching deltas, then `output_item_stop`. The encoder
 * owns index assignment, item-id minting, and the SSE framing.
 */
export type ResponsesStreamEvent =
  | { type: 'response_created'; model: string; id?: string }
  | { type: 'output_item_start'; item: CanonicalItemInit }
  /** Text delta into an open `message` item. */
  | { type: 'output_text'; text: string }
  /** Partial function-arguments delta into an open `function_call` item. */
  | { type: 'function_arguments'; delta: string }
  | { type: 'output_item_stop' }
  | {
      type: 'response_done';
      status: ResponseStatus;
      usage?: CanonicalResponseUsage;
      incompleteReason?: string;
      error?: { code?: string; message: string };
    };

/** Thrown when a canonical event violates the Responses stream ordering rules. */
export class ResponsesStreamEncoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponsesStreamEncoderError';
  }
}

/** Dependencies for {@link ResponsesSseEncoder}. */
export interface ResponsesStreamEncoderDeps {
  /** Id generator; defaults to a UUID-backed generator. */
  genId?: IdGen;
  /** Epoch-millis clock; `created_at` is `floor(now/1000)`. Defaults to Date.now. */
  now?: () => number;
  /** Request-derived fields echoed onto every response snapshot. */
  echo?: ResponsesEcho;
}

/** State for the item currently open. */
type OpenItem =
  | { kind: 'message'; index: number; id: string; text: string }
  | {
      kind: 'function_call';
      index: number;
      id: string;
      callId: string;
      name: string;
      args: string;
    };

/**
 * A stateful encoder. Feed it canonical events with {@link encode}; each call
 * returns the SSE record(s) for that event. One encoder instance encodes exactly
 * one response.
 */
export class ResponsesSseEncoder {
  private readonly genId: IdGen;
  private readonly createdAt: number;
  private readonly echo?: ResponsesEcho;

  private created = false;
  private done = false;
  private responseId = '';
  private model = '';
  private sequence = 0;
  private nextOutputIndex = 0;
  private openItem: OpenItem | null = null;
  /** Completed canonical outputs, for the terminal snapshot. */
  private readonly outputs: CanonicalOutput[] = [];
  /** Completed rendered items, reused verbatim in the terminal snapshot. */
  private readonly renderedItems: ResponsesOutputItem[] = [];

  constructor(deps: ResponsesStreamEncoderDeps = {}) {
    this.genId = deps.genId ?? uuidGen;
    const nowMs = deps.now ? deps.now() : Date.now();
    this.createdAt = Math.floor(nowMs / 1000);
    this.echo = deps.echo;
  }

  /** True once a terminal response event has been encoded. */
  get finished(): boolean {
    return this.done;
  }

  /** Encode one canonical event into its SSE record(s). */
  encode(event: ResponsesStreamEvent): string {
    if (this.done) {
      throw new ResponsesStreamEncoderError(
        `no events may follow the terminal response event (got "${event.type}")`,
      );
    }
    switch (event.type) {
      case 'response_created':
        return this.onResponseCreated(event);
      case 'output_item_start':
        return this.onOutputItemStart(event.item);
      case 'output_text':
        return this.onOutputText(event.text);
      case 'function_arguments':
        return this.onFunctionArguments(event.delta);
      case 'output_item_stop':
        return this.onOutputItemStop();
      case 'response_done':
        return this.onResponseDone(event);
      default: {
        const exhaustive: never = event;
        throw new ResponsesStreamEncoderError(
          `unknown event ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  private requireCreated(what: string): void {
    if (!this.created) {
      throw new ResponsesStreamEncoderError(`${what} before response.created`);
    }
  }

  /** The in-progress response snapshot carried on created / in_progress. */
  private snapshot(status: ResponseSnapshotStatus): Record<string, unknown> {
    return renderResponseEnvelope({
      id: this.responseId,
      model: this.model,
      status,
      createdAt: this.createdAt,
      outputs: [...this.renderedItems],
      outputText: aggregateOutputText(this.outputs),
      echo: this.echo,
    });
  }

  private onResponseCreated(
    event: Extract<ResponsesStreamEvent, { type: 'response_created' }>,
  ): string {
    if (this.created) {
      throw new ResponsesStreamEncoderError(
        'response.created emitted more than once',
      );
    }
    this.created = true;
    this.model = event.model;
    this.responseId = event.id ?? prefixedId(this.genId, 'resp');
    // response.created then response.in_progress, both carrying the snapshot.
    return (
      this.frame('response.created', {
        response: this.snapshot('in_progress'),
      }) +
      this.frame('response.in_progress', {
        response: this.snapshot('in_progress'),
      })
    );
  }

  private onOutputItemStart(item: CanonicalItemInit): string {
    this.requireCreated('output_item.added');
    if (this.openItem !== null) {
      throw new ResponsesStreamEncoderError(
        `output_item_start while item ${this.openItem.index} is still open`,
      );
    }
    const index = this.nextOutputIndex;
    this.nextOutputIndex += 1;

    if (item.kind === 'message') {
      const id = prefixedId(this.genId, 'msg');
      this.openItem = { kind: 'message', index, id, text: '' };
      // output_item.added (skeleton) then content_part.added for the text part.
      return (
        this.frame('response.output_item.added', {
          output_index: index,
          item: {
            id,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        }) +
        this.frame('response.content_part.added', {
          item_id: id,
          output_index: index,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        })
      );
    }

    const id = prefixedId(this.genId, 'fc');
    this.openItem = {
      kind: 'function_call',
      index,
      id,
      callId: item.callId,
      name: item.name,
      args: '',
    };
    return this.frame('response.output_item.added', {
      output_index: index,
      item: {
        id,
        type: 'function_call',
        status: 'in_progress',
        arguments: '',
        call_id: item.callId,
        name: item.name,
      },
    });
  }

  private onOutputText(text: string): string {
    this.requireCreated('output_text.delta');
    if (this.openItem === null || this.openItem.kind !== 'message') {
      throw new ResponsesStreamEncoderError(
        'output_text.delta requires an open message item',
      );
    }
    this.openItem.text += text;
    return this.frame('response.output_text.delta', {
      item_id: this.openItem.id,
      output_index: this.openItem.index,
      content_index: 0,
      delta: text,
    });
  }

  private onFunctionArguments(delta: string): string {
    this.requireCreated('function_call_arguments.delta');
    if (this.openItem === null || this.openItem.kind !== 'function_call') {
      throw new ResponsesStreamEncoderError(
        'function_call_arguments.delta requires an open function_call item',
      );
    }
    this.openItem.args += delta;
    return this.frame('response.function_call_arguments.delta', {
      item_id: this.openItem.id,
      output_index: this.openItem.index,
      delta,
    });
  }

  private onOutputItemStop(): string {
    const item = this.openItem;
    if (item === null) {
      throw new ResponsesStreamEncoderError(
        'output_item_stop with no open item',
      );
    }
    this.openItem = null;

    if (item.kind === 'message') {
      const rendered = messageOutputItem(item.id, item.text);
      this.outputs.push({ kind: 'message', text: item.text });
      this.renderedItems.push(rendered);
      return (
        this.frame('response.output_text.done', {
          item_id: item.id,
          output_index: item.index,
          content_index: 0,
          text: item.text,
        }) +
        this.frame('response.content_part.done', {
          item_id: item.id,
          output_index: item.index,
          content_index: 0,
          part: { type: 'output_text', text: item.text, annotations: [] },
        }) +
        this.frame('response.output_item.done', {
          output_index: item.index,
          item: rendered,
        })
      );
    }

    const rendered = functionCallOutputItem(
      item.id,
      item.callId,
      item.name,
      item.args,
    );
    this.outputs.push({
      kind: 'function_call',
      callId: item.callId,
      name: item.name,
      arguments: item.args,
    });
    this.renderedItems.push(rendered);
    return (
      this.frame('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: item.index,
        arguments: item.args,
      }) +
      this.frame('response.output_item.done', {
        output_index: item.index,
        item: rendered,
      })
    );
  }

  private onResponseDone(
    event: Extract<ResponsesStreamEvent, { type: 'response_done' }>,
  ): string {
    this.requireCreated('terminal response event');
    if (this.openItem !== null) {
      throw new ResponsesStreamEncoderError(
        `terminal response event while item ${this.openItem.index} is still open`,
      );
    }
    this.done = true;
    const response = renderResponseEnvelope({
      id: this.responseId,
      model: this.model,
      status: event.status,
      createdAt: this.createdAt,
      outputs: [...this.renderedItems],
      outputText: aggregateOutputText(this.outputs),
      usage: event.usage,
      incompleteReason: event.incompleteReason,
      error: event.error,
      echo: this.echo,
    });
    const terminalType =
      event.status === 'completed'
        ? 'response.completed'
        : event.status === 'failed'
          ? 'response.failed'
          : 'response.incomplete';
    return this.frame(terminalType, { response });
  }

  /** Frame one SSE record with its `type` and a fresh `sequence_number`. */
  private frame(type: string, data: Record<string, unknown>): string {
    const payload = { type, sequence_number: this.sequence, ...data };
    this.sequence += 1;
    return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  }
}

/**
 * Expand a completed canonical result into the stream event script that
 * reproduces it. Used to serve a streaming Responses request from a
 * non-streaming (or reconstructed) upstream result: the result is turned into
 * the canonical event sequence and fed through {@link encodeResponsesStream}.
 */
export function streamEventsForResult(
  result: CanonicalResponseResult,
): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [
    { type: 'response_created', model: result.model, id: result.id },
  ];
  for (const output of result.outputs) {
    if (output.kind === 'message') {
      events.push({ type: 'output_item_start', item: { kind: 'message' } });
      events.push({ type: 'output_text', text: output.text });
      events.push({ type: 'output_item_stop' });
    } else {
      events.push({
        type: 'output_item_start',
        item: {
          kind: 'function_call',
          callId: output.callId,
          name: output.name,
        },
      });
      events.push({ type: 'function_arguments', delta: output.arguments });
      events.push({ type: 'output_item_stop' });
    }
  }
  events.push({
    type: 'response_done',
    status: result.status,
    usage: result.usage,
    incompleteReason: result.incompleteReason,
    error: result.error,
  });
  return events;
}

/**
 * Encode a full canonical event script into a single Responses SSE transcript.
 * Enforces every invariant of {@link ResponsesSseEncoder} and additionally
 * requires the script to terminate with a terminal response event.
 */
export function encodeResponsesStream(
  events: Iterable<ResponsesStreamEvent>,
  deps: ResponsesStreamEncoderDeps = {},
): string {
  const encoder = new ResponsesSseEncoder(deps);
  let out = '';
  for (const event of events) {
    out += encoder.encode(event);
  }
  if (!encoder.finished) {
    throw new ResponsesStreamEncoderError(
      'stream did not terminate with a terminal response event',
    );
  }
  return out;
}
