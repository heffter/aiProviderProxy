/**
 * Anthropic Messages SSE state-machine encoder (epic AIPP-6, subtask 6.3).
 *
 * Renders a stream of provider-neutral *canonical* stream events as a spec-valid
 * Anthropic Server-Sent Events sequence:
 *
 *   message_start
 *     (content_block_start content_block_delta* content_block_stop)*
 *   message_delta
 *   message_stop
 *
 * with `ping` events permitted anywhere inside the message. The encoder is a
 * state machine: it assigns block indexes (monotonically increasing from 0),
 * frames each event as an `event:`/`data:` SSE record, and enforces the Anthropic
 * ordering invariants -- a block must be open before deltas flow into it, delta
 * kinds must match the open block, exactly one terminal `message_stop` is emitted,
 * and nothing may follow it. Illegal transitions throw {@link StreamEncoderError}
 * rather than emitting a malformed transcript.
 *
 * The canonical model is deliberately upstream-agnostic (an Anthropic or an
 * OpenAI upstream stream both normalize into it); this encoder owns the Anthropic
 * client-surface wire format only.
 */

import { uuidGen, type IdGen } from '../../lifecycle/index.js';

/** Anthropic stop reasons carried on the terminal `message_delta`. */
export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal';

/** Token usage carried on `message_start` / `message_delta` (canonical shape). */
export interface CanonicalStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** The kind of content block being opened. */
export type CanonicalBlockInit =
  | { kind: 'text' }
  | { kind: 'tool_use'; id: string; name: string }
  | { kind: 'thinking' };

/**
 * A provider-neutral stream event. Block lifecycle is explicit: open a block with
 * `block_start`, push matching deltas, then `block_stop`. The encoder owns index
 * assignment and the SSE framing.
 */
export type CanonicalStreamEvent =
  | {
      type: 'message_start';
      model: string;
      role?: 'assistant';
      id?: string;
      usage?: CanonicalStreamUsage;
    }
  | { type: 'block_start'; block: CanonicalBlockInit }
  /** Text delta into an open `text` block. */
  | { type: 'text'; text: string }
  /** Partial-JSON delta into an open `tool_use` block. */
  | { type: 'json'; partial: string }
  /** Reasoning delta into an open `thinking` block. */
  | { type: 'thinking'; text: string }
  /** Signature delta into an open `thinking` block. */
  | { type: 'signature'; signature: string }
  | { type: 'block_stop' }
  | {
      type: 'message_delta';
      stopReason: AnthropicStopReason;
      stopSequence?: string | null;
      usage?: CanonicalStreamUsage;
    }
  | { type: 'message_stop' }
  | { type: 'ping' };

/** Thrown when a canonical event violates the Anthropic stream ordering rules. */
export class StreamEncoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamEncoderError';
  }
}

/** Dependencies for {@link AnthropicSseEncoder}. */
export interface StreamEncoderDeps {
  /** Message-id generator; defaults to a UUID-backed `msg_`-prefixed id. */
  genId?: IdGen;
}

type OpenBlockKind = CanonicalBlockInit['kind'] | null;

/** Serialize an Anthropic input-usage object, omitting absent cache fields. */
function startUsage(
  usage: CanonicalStreamUsage | undefined,
): Record<string, number> {
  const out: Record<string, number> = {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
  };
  if (usage?.cacheReadTokens !== undefined) {
    out.cache_read_input_tokens = usage.cacheReadTokens;
  }
  if (usage?.cacheWriteTokens !== undefined) {
    out.cache_creation_input_tokens = usage.cacheWriteTokens;
  }
  return out;
}

/** Serialize the `message_delta.usage` object (output-focused). */
function deltaUsage(
  usage: CanonicalStreamUsage | undefined,
): Record<string, number> {
  const out: Record<string, number> = {
    output_tokens: usage?.outputTokens ?? 0,
  };
  if (usage?.inputTokens !== undefined) {
    out.input_tokens = usage.inputTokens;
  }
  return out;
}

/**
 * A stateful encoder. Feed it canonical events with {@link encode}; each call
 * returns the SSE record for that event. One encoder instance encodes exactly
 * one message.
 */
export class AnthropicSseEncoder {
  private readonly genId: IdGen;
  private started = false;
  private stopped = false;
  private openBlock: OpenBlockKind = null;
  private nextIndex = 0;
  private currentIndex = -1;
  private messageId = '';

  constructor(deps: StreamEncoderDeps = {}) {
    this.genId = deps.genId ?? (() => `msg_${uuidGen().replace(/-/g, '')}`);
  }

  /** True once a terminal `message_stop` has been encoded. */
  get done(): boolean {
    return this.stopped;
  }

  /** Encode one canonical event into its SSE record(s). */
  encode(event: CanonicalStreamEvent): string {
    if (this.stopped) {
      throw new StreamEncoderError(
        `no events may follow message_stop (got "${event.type}")`,
      );
    }
    switch (event.type) {
      case 'message_start':
        return this.onMessageStart(event);
      case 'ping':
        this.requireStarted('ping');
        return frame('ping', { type: 'ping' });
      case 'block_start':
        return this.onBlockStart(event.block);
      case 'text':
        return this.onDelta('text', 'text_delta', { text: event.text });
      case 'json':
        return this.onDelta('tool_use', 'input_json_delta', {
          partial_json: event.partial,
        });
      case 'thinking':
        return this.onDelta('thinking', 'thinking_delta', {
          thinking: event.text,
        });
      case 'signature':
        return this.onDelta('thinking', 'signature_delta', {
          signature: event.signature,
        });
      case 'block_stop':
        return this.onBlockStop();
      case 'message_delta':
        return this.onMessageDelta(event);
      case 'message_stop':
        return this.onMessageStop();
      default: {
        const exhaustive: never = event;
        throw new StreamEncoderError(
          `unknown event ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  private requireStarted(what: string): void {
    if (!this.started) {
      throw new StreamEncoderError(`${what} before message_start`);
    }
  }

  private onMessageStart(
    event: Extract<CanonicalStreamEvent, { type: 'message_start' }>,
  ): string {
    if (this.started) {
      throw new StreamEncoderError('message_start emitted more than once');
    }
    this.started = true;
    this.messageId = event.id ?? this.genId();
    return frame('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: event.role ?? 'assistant',
        model: event.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: startUsage(event.usage),
      },
    });
  }

  private onBlockStart(block: CanonicalBlockInit): string {
    this.requireStarted('block_start');
    if (this.openBlock !== null) {
      throw new StreamEncoderError(
        `block_start while block ${this.currentIndex} is still open`,
      );
    }
    this.openBlock = block.kind;
    this.currentIndex = this.nextIndex;
    this.nextIndex += 1;
    return frame('content_block_start', {
      type: 'content_block_start',
      index: this.currentIndex,
      content_block: initialBlock(block),
    });
  }

  private onDelta(
    requiredKind: CanonicalBlockInit['kind'],
    deltaType: string,
    delta: Record<string, string>,
  ): string {
    this.requireStarted(deltaType);
    if (this.openBlock === null) {
      throw new StreamEncoderError(`${deltaType} with no open block`);
    }
    if (this.openBlock !== requiredKind) {
      throw new StreamEncoderError(
        `${deltaType} requires an open ${requiredKind} block, ` +
          `but block ${this.currentIndex} is ${this.openBlock}`,
      );
    }
    return frame('content_block_delta', {
      type: 'content_block_delta',
      index: this.currentIndex,
      delta: { type: deltaType, ...delta },
    });
  }

  private onBlockStop(): string {
    if (this.openBlock === null) {
      throw new StreamEncoderError('content_block_stop with no open block');
    }
    const index = this.currentIndex;
    this.openBlock = null;
    return frame('content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  }

  private onMessageDelta(
    event: Extract<CanonicalStreamEvent, { type: 'message_delta' }>,
  ): string {
    this.requireStarted('message_delta');
    if (this.openBlock !== null) {
      throw new StreamEncoderError(
        `message_delta while block ${this.currentIndex} is still open`,
      );
    }
    return frame('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: event.stopReason,
        stop_sequence: event.stopSequence ?? null,
      },
      usage: deltaUsage(event.usage),
    });
  }

  private onMessageStop(): string {
    this.requireStarted('message_stop');
    if (this.openBlock !== null) {
      throw new StreamEncoderError(
        `message_stop while block ${this.currentIndex} is still open`,
      );
    }
    this.stopped = true;
    return frame('message_stop', { type: 'message_stop' });
  }
}

/** The `content_block` object emitted on `content_block_start`. */
function initialBlock(block: CanonicalBlockInit): Record<string, unknown> {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: '' };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: {} };
    case 'thinking':
      // signature is not present at block start; it arrives via signature_delta.
      return { type: 'thinking', thinking: '' };
  }
}

/** Frame one SSE record: `event:` line, `data:` line, blank-line terminator. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Stop reasons the Anthropic stream may carry; anything else maps to end_turn. */
const STOP_REASONS: readonly string[] = [
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
];

/** The non-streaming Messages response shape this expander reads. */
interface AnthropicMessageLike {
  id?: unknown;
  content?: unknown;
  stop_reason?: unknown;
  stop_sequence?: unknown;
  usage?: Record<string, unknown>;
}

/** Read a numeric usage field, ignoring absent or non-numeric values. */
function usageNumber(
  usage: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = usage?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** Map an Anthropic `usage` object onto the canonical stream usage shape. */
function canonicalUsage(
  usage: Record<string, unknown> | undefined,
): CanonicalStreamUsage {
  return {
    inputTokens: usageNumber(usage, 'input_tokens'),
    outputTokens: usageNumber(usage, 'output_tokens'),
    cacheReadTokens: usageNumber(usage, 'cache_read_input_tokens'),
    cacheWriteTokens: usageNumber(usage, 'cache_creation_input_tokens'),
  };
}

/**
 * Expand the content blocks of a completed message into their canonical events.
 *
 * Each block becomes a `block_start` / delta / `block_stop` triple; a block of
 * an unrecognized type is skipped rather than emitted malformed, because the
 * encoder would reject it and take the whole stream down with it.
 */
function blockEvents(content: unknown): CanonicalStreamEvent[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const events: CanonicalStreamEvent[] = [];
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case 'text':
        events.push({ type: 'block_start', block: { kind: 'text' } });
        if (typeof block.text === 'string' && block.text.length > 0) {
          events.push({ type: 'text', text: block.text });
        }
        events.push({ type: 'block_stop' });
        break;
      case 'tool_use':
        events.push({
          type: 'block_start',
          block: {
            kind: 'tool_use',
            id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : '',
          },
        });
        // The whole argument object arrives as one partial-JSON delta: a
        // completed message has no finer granularity to reproduce.
        events.push({
          type: 'json',
          partial: JSON.stringify(block.input ?? {}),
        });
        events.push({ type: 'block_stop' });
        break;
      case 'thinking':
        events.push({ type: 'block_start', block: { kind: 'thinking' } });
        if (typeof block.thinking === 'string' && block.thinking.length > 0) {
          events.push({ type: 'thinking', text: block.thinking });
        }
        if (typeof block.signature === 'string' && block.signature.length > 0) {
          events.push({ type: 'signature', signature: block.signature });
        }
        events.push({ type: 'block_stop' });
        break;
      default:
        break;
    }
  }
  return events;
}

/**
 * Expand a completed Anthropic message into the stream event script that
 * reproduces it, mirroring `streamEventsForChatResult` on the Chat surface.
 *
 * Used to serve a streaming Messages request from a non-streaming (or
 * translated) upstream result via {@link encodeAnthropicStream}.
 *
 * @param message A non-streaming Messages response body.
 * @param model The routed model to stamp on `message_start`.
 * @returns A canonical event script terminating in `message_stop`.
 */
export function streamEventsForAnthropicMessage(
  message: unknown,
  model: string,
): CanonicalStreamEvent[] {
  const body = (
    typeof message === 'object' && message !== null ? message : {}
  ) as AnthropicMessageLike;
  const usage = canonicalUsage(body.usage);
  const stopReason = STOP_REASONS.includes(body.stop_reason as string)
    ? (body.stop_reason as AnthropicStopReason)
    : 'end_turn';
  return [
    {
      type: 'message_start',
      model,
      ...(typeof body.id === 'string' ? { id: body.id } : {}),
      // message_start carries the input side; output tokens land on the delta.
      usage: { ...usage, outputTokens: 0 },
    },
    ...blockEvents(body.content),
    {
      type: 'message_delta',
      stopReason,
      stopSequence:
        typeof body.stop_sequence === 'string' ? body.stop_sequence : null,
      usage,
    },
    { type: 'message_stop' },
  ];
}

/**
 * Encode a full canonical event script into a single Anthropic SSE transcript.
 * Enforces every invariant of {@link AnthropicSseEncoder} and additionally
 * requires the script to terminate with `message_stop`.
 */
export function encodeAnthropicStream(
  events: Iterable<CanonicalStreamEvent>,
  deps: StreamEncoderDeps = {},
): string {
  const encoder = new AnthropicSseEncoder(deps);
  let out = '';
  for (const event of events) {
    out += encoder.encode(event);
  }
  if (!encoder.done) {
    throw new StreamEncoderError('stream did not terminate with message_stop');
  }
  return out;
}
