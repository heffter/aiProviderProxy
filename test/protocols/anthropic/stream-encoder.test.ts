/**
 * Unit tests for the Anthropic SSE state-machine encoder (AIPP-6, subtask 6.3).
 *
 * Drives the encoder with canonical event scripts (interleaved text and tool
 * blocks, thinking, ping), asserts golden SSE transcripts and usage mapping, and
 * verifies every ordering invariant throws on an illegal transition.
 */

import { describe, it, expect } from 'vitest';
import {
  AnthropicSseEncoder,
  encodeAnthropicStream,
  StreamEncoderError,
  type CanonicalStreamEvent,
} from '../../../src/protocols/anthropic/stream-encoder.js';

/** Parse an SSE transcript into ordered {event, data} records. */
function parse(sse: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of sse.split('\n\n')) {
    if (block.trim() === '') continue;
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) data = line.slice('data: '.length);
    }
    out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

const fixedId = () => 'msg_fixed';

describe('AnthropicSseEncoder golden transcripts', () => {
  it('encodes a single text block end to end', () => {
    const script: CanonicalStreamEvent[] = [
      {
        type: 'message_start',
        model: 'claude-sonnet-4',
        usage: { inputTokens: 10 },
      },
      { type: 'ping' },
      { type: 'block_start', block: { kind: 'text' } },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ', world' },
      { type: 'block_stop' },
      {
        type: 'message_delta',
        stopReason: 'end_turn',
        usage: { outputTokens: 5 },
      },
      { type: 'message_stop' },
    ];
    const sse = encodeAnthropicStream(script, { genId: fixedId });
    const records = parse(sse);
    expect(records.map((r) => r.event)).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const start = records[0].data as {
      message: { id: string; model: string; usage: Record<string, number> };
    };
    expect(start.message.id).toBe('msg_fixed');
    expect(start.message.model).toBe('claude-sonnet-4');
    expect(start.message.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 0,
    });

    const firstDelta = records[3].data as {
      index: number;
      delta: { type: string; text: string };
    };
    expect(firstDelta.index).toBe(0);
    expect(firstDelta.delta).toEqual({ type: 'text_delta', text: 'Hello' });

    const msgDelta = records[6].data as {
      delta: { stop_reason: string; stop_sequence: null };
      usage: Record<string, number>;
    };
    expect(msgDelta.delta).toEqual({
      stop_reason: 'end_turn',
      stop_sequence: null,
    });
    expect(msgDelta.usage).toEqual({ output_tokens: 5 });
  });

  it('assigns monotonically increasing indexes across interleaved blocks', () => {
    const script: CanonicalStreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'block_start', block: { kind: 'text' } },
      { type: 'text', text: 'let me check' },
      { type: 'block_stop' },
      {
        type: 'block_start',
        block: { kind: 'tool_use', id: 'toolu_1', name: 'get_weather' },
      },
      { type: 'json', partial: '{"city":' },
      { type: 'json', partial: '"SF"}' },
      { type: 'block_stop' },
      { type: 'block_start', block: { kind: 'text' } },
      { type: 'text', text: 'done' },
      { type: 'block_stop' },
      { type: 'message_delta', stopReason: 'tool_use' },
      { type: 'message_stop' },
    ];
    const records = parse(encodeAnthropicStream(script));
    const starts = records.filter((r) => r.event === 'content_block_start');
    expect(starts.map((r) => (r.data as { index: number }).index)).toEqual([
      0, 1, 2,
    ]);

    const toolStart = starts[1].data as {
      index: number;
      content_block: { type: string; id: string; name: string; input: unknown };
    };
    expect(toolStart.content_block).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'get_weather',
      input: {},
    });

    const jsonDeltas = records.filter(
      (r) =>
        r.event === 'content_block_delta' &&
        (r.data as { delta: { type: string } }).delta.type ===
          'input_json_delta',
    );
    expect(
      jsonDeltas.map(
        (r) =>
          (r.data as { delta: { partial_json: string } }).delta.partial_json,
      ),
    ).toEqual(['{"city":', '"SF"}']);
    // both tool deltas carry the tool block's index (1)
    expect(
      jsonDeltas.every((r) => (r.data as { index: number }).index === 1),
    ).toBe(true);
  });

  it('encodes a thinking block with signature delta', () => {
    const script: CanonicalStreamEvent[] = [
      { type: 'message_start', model: 'm' },
      { type: 'block_start', block: { kind: 'thinking' } },
      { type: 'thinking', text: 'reasoning...' },
      { type: 'signature', signature: 'sig-abc' },
      { type: 'block_stop' },
      { type: 'message_delta', stopReason: 'end_turn' },
      { type: 'message_stop' },
    ];
    const records = parse(encodeAnthropicStream(script));
    const deltas = records.filter((r) => r.event === 'content_block_delta');
    expect((deltas[0].data as { delta: unknown }).delta).toEqual({
      type: 'thinking_delta',
      thinking: 'reasoning...',
    });
    expect((deltas[1].data as { delta: unknown }).delta).toEqual({
      type: 'signature_delta',
      signature: 'sig-abc',
    });
  });

  it('maps cache usage fields on message_start', () => {
    const sse = new AnthropicSseEncoder({ genId: fixedId }).encode({
      type: 'message_start',
      model: 'm',
      usage: { inputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 8 },
    });
    const data = parse(sse)[0].data as { message: { usage: unknown } };
    expect(data.message.usage).toEqual({
      input_tokens: 4,
      output_tokens: 0,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 8,
    });
  });

  it('generates a msg_-prefixed id by default', () => {
    const sse = new AnthropicSseEncoder().encode({
      type: 'message_start',
      model: 'm',
    });
    const id = (parse(sse)[0].data as { message: { id: string } }).message.id;
    expect(id).toMatch(/^msg_[0-9a-f]{32}$/);
  });
});

describe('AnthropicSseEncoder invariants', () => {
  function enc(): AnthropicSseEncoder {
    return new AnthropicSseEncoder({ genId: fixedId });
  }
  function started(): AnthropicSseEncoder {
    const e = enc();
    e.encode({ type: 'message_start', model: 'm' });
    return e;
  }

  it('rejects a delta before message_start', () => {
    expect(() => enc().encode({ type: 'text', text: 'x' })).toThrow(
      StreamEncoderError,
    );
  });

  it('rejects a second message_start', () => {
    const e = started();
    expect(() => e.encode({ type: 'message_start', model: 'm' })).toThrow(
      /more than once/,
    );
  });

  it('rejects block_start while a block is open', () => {
    const e = started();
    e.encode({ type: 'block_start', block: { kind: 'text' } });
    expect(() =>
      e.encode({ type: 'block_start', block: { kind: 'text' } }),
    ).toThrow(/still open/);
  });

  it('rejects a text delta with no open block', () => {
    expect(() => started().encode({ type: 'text', text: 'x' })).toThrow(
      /no open block/,
    );
  });

  it('rejects a text delta into a tool_use block', () => {
    const e = started();
    e.encode({
      type: 'block_start',
      block: { kind: 'tool_use', id: 't', name: 'n' },
    });
    expect(() => e.encode({ type: 'text', text: 'x' })).toThrow(
      /requires an open text block/,
    );
  });

  it('rejects a json delta into a text block', () => {
    const e = started();
    e.encode({ type: 'block_start', block: { kind: 'text' } });
    expect(() => e.encode({ type: 'json', partial: '{}' })).toThrow(
      /requires an open tool_use block/,
    );
  });

  it('rejects content_block_stop with no open block', () => {
    expect(() => started().encode({ type: 'block_stop' })).toThrow(
      /no open block/,
    );
  });

  it('rejects message_delta while a block is open', () => {
    const e = started();
    e.encode({ type: 'block_start', block: { kind: 'text' } });
    expect(() =>
      e.encode({ type: 'message_delta', stopReason: 'end_turn' }),
    ).toThrow(/still open/);
  });

  it('rejects message_stop while a block is open', () => {
    const e = started();
    e.encode({ type: 'block_start', block: { kind: 'text' } });
    expect(() => e.encode({ type: 'message_stop' })).toThrow(/still open/);
  });

  it('rejects any event after message_stop', () => {
    const e = started();
    e.encode({ type: 'message_stop' });
    expect(e.done).toBe(true);
    expect(() => e.encode({ type: 'ping' })).toThrow(/no events may follow/);
  });

  it('rejects a ping before message_start', () => {
    expect(() => enc().encode({ type: 'ping' })).toThrow(
      /before message_start/,
    );
  });

  it('rejects a script that does not terminate with message_stop', () => {
    expect(() =>
      encodeAnthropicStream([{ type: 'message_start', model: 'm' }]),
    ).toThrow(/did not terminate/);
  });
});
