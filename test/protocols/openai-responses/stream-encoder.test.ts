/**
 * Unit tests for the Responses SSE state-machine encoder (AIPP-7, 7.3).
 */

import { describe, it, expect } from 'vitest';
import {
  ResponsesSseEncoder,
  ResponsesStreamEncoderError,
  encodeResponsesStream,
  type ResponsesStreamEvent,
} from '../../../src/protocols/openai-responses/stream-encoder.js';

/** A deterministic id generator: id1, id2, ... so transcripts are stable. */
function seqIdGen(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id${n}`;
  };
}

const fixedNow = (): number => 1_700_000_000_000;

/** Parse an SSE transcript into `{ event, data }` records. */
function parseSse(
  transcript: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  return transcript
    .split('\n\n')
    .filter((r) => r.trim().length > 0)
    .map((record) => {
      const lines = record.split('\n');
      const event = lines[0].replace(/^event: /, '');
      const data = JSON.parse(lines[1].replace(/^data: /, ''));
      return { event, data };
    });
}

function encode(
  events: ResponsesStreamEvent[],
): Array<{ event: string; data: Record<string, unknown> }> {
  return parseSse(
    encodeResponsesStream(events, { genId: seqIdGen(), now: fixedNow }),
  );
}

describe('encodeResponsesStream — text only', () => {
  const records = encode([
    { type: 'response_created', model: 'gpt-5-codex' },
    { type: 'output_item_start', item: { kind: 'message' } },
    { type: 'output_text', text: 'Hello' },
    { type: 'output_text', text: ', world' },
    { type: 'output_item_stop' },
    {
      type: 'response_done',
      status: 'completed',
      usage: { inputTokens: 5, outputTokens: 2 },
    },
  ]);

  it('emits the spec event sequence in order', () => {
    expect(records.map((r) => r.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  it('assigns a monotonic sequence_number from 0', () => {
    records.forEach((r, i) => {
      expect(r.data.sequence_number).toBe(i);
      expect(r.data.type).toBe(r.event);
    });
  });

  it('accumulates text into output_text.done and the terminal snapshot', () => {
    const done = records.find((r) => r.event === 'response.output_text.done');
    expect(done?.data.text).toBe('Hello, world');
    const completed = records[records.length - 1];
    const response = completed.data.response as Record<string, unknown>;
    expect(response.status).toBe('completed');
    expect(response.output_text).toBe('Hello, world');
    expect(response.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 2,
      total_tokens: 7,
    });
  });

  it('the terminal message item matches the non-streaming render', () => {
    const completed = records[records.length - 1];
    const response = completed.data.response as { output: unknown[] };
    expect(response.output).toEqual([
      {
        type: 'message',
        id: 'msg_id2',
        status: 'completed',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Hello, world', annotations: [] },
        ],
      },
    ]);
  });

  it('carries the same response id across every snapshot', () => {
    const ids = records
      .filter((r) => r.data.response)
      .map((r) => (r.data.response as { id: string }).id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe('resp_id1');
  });
});

describe('encodeResponsesStream — tool call', () => {
  const records = encode([
    { type: 'response_created', model: 'gpt-5-codex', id: 'resp_x' },
    {
      type: 'output_item_start',
      item: { kind: 'function_call', callId: 'call_1', name: 'get_weather' },
    },
    { type: 'function_arguments', delta: '{"city":' },
    { type: 'function_arguments', delta: '"SF"}' },
    { type: 'output_item_stop' },
    {
      type: 'response_done',
      status: 'completed',
      usage: { inputTokens: 8, outputTokens: 6 },
    },
  ]);

  it('emits function_call_arguments events and no content_part events', () => {
    expect(records.map((r) => r.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  it('assembles the full arguments string', () => {
    const done = records.find(
      (r) => r.event === 'response.function_call_arguments.done',
    );
    expect(done?.data.arguments).toBe('{"city":"SF"}');
    const item = records.find((r) => r.event === 'response.output_item.done');
    expect(item?.data.item).toEqual({
      type: 'function_call',
      id: 'fc_id1',
      status: 'completed',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"SF"}',
    });
  });

  it('honors a provider-supplied response id', () => {
    expect((records[0].data.response as { id: string }).id).toBe('resp_x');
  });
});

describe('encodeResponsesStream — mixed and terminal variants', () => {
  it('assigns increasing output_index across multiple items', () => {
    const records = encode([
      { type: 'response_created', model: 'm' },
      { type: 'output_item_start', item: { kind: 'message' } },
      { type: 'output_text', text: 'hi' },
      { type: 'output_item_stop' },
      {
        type: 'output_item_start',
        item: { kind: 'function_call', callId: 'c', name: 'f' },
      },
      { type: 'function_arguments', delta: '{}' },
      { type: 'output_item_stop' },
      { type: 'response_done', status: 'completed' },
    ]);
    const added = records.filter(
      (r) => r.event === 'response.output_item.added',
    );
    expect(added.map((r) => r.data.output_index)).toEqual([0, 1]);
    const terminal = records[records.length - 1];
    const response = terminal.data.response as { output: unknown[] };
    expect(response.output).toHaveLength(2);
  });

  it('emits response.incomplete with incomplete_details', () => {
    const records = encode([
      { type: 'response_created', model: 'm' },
      { type: 'output_item_start', item: { kind: 'message' } },
      { type: 'output_text', text: 'partial' },
      { type: 'output_item_stop' },
      {
        type: 'response_done',
        status: 'incomplete',
        incompleteReason: 'max_output_tokens',
        usage: { inputTokens: 4, outputTokens: 256 },
      },
    ]);
    const terminal = records[records.length - 1];
    expect(terminal.event).toBe('response.incomplete');
    const response = terminal.data.response as Record<string, unknown>;
    expect(response.incomplete_details).toEqual({
      reason: 'max_output_tokens',
    });
  });

  it('emits response.failed early with an error object', () => {
    const records = encode([
      { type: 'response_created', model: 'm' },
      {
        type: 'response_done',
        status: 'failed',
        error: { code: 'server_error', message: 'boom' },
      },
    ]);
    const terminal = records[records.length - 1];
    expect(terminal.event).toBe('response.failed');
    const response = terminal.data.response as Record<string, unknown>;
    expect(response.error).toEqual({ code: 'server_error', message: 'boom' });
    expect(response.output).toEqual([]);
  });
});

describe('ResponsesSseEncoder — ordering invariants', () => {
  it('rejects a delta before response.created', () => {
    const enc = new ResponsesSseEncoder();
    expect(() => enc.encode({ type: 'output_text', text: 'x' })).toThrow(
      ResponsesStreamEncoderError,
    );
  });

  it('rejects response.created twice', () => {
    const enc = new ResponsesSseEncoder({ genId: seqIdGen(), now: fixedNow });
    enc.encode({ type: 'response_created', model: 'm' });
    expect(() => enc.encode({ type: 'response_created', model: 'm' })).toThrow(
      /more than once/,
    );
  });

  it('rejects a new item while one is still open', () => {
    const enc = new ResponsesSseEncoder({ genId: seqIdGen(), now: fixedNow });
    enc.encode({ type: 'response_created', model: 'm' });
    enc.encode({ type: 'output_item_start', item: { kind: 'message' } });
    expect(() =>
      enc.encode({ type: 'output_item_start', item: { kind: 'message' } }),
    ).toThrow(/still open/);
  });

  it('rejects output_text into a function_call item', () => {
    const enc = new ResponsesSseEncoder({ genId: seqIdGen(), now: fixedNow });
    enc.encode({ type: 'response_created', model: 'm' });
    enc.encode({
      type: 'output_item_start',
      item: { kind: 'function_call', callId: 'c', name: 'f' },
    });
    expect(() => enc.encode({ type: 'output_text', text: 'x' })).toThrow(
      /requires an open message item/,
    );
  });

  it('rejects function_arguments into a message item', () => {
    const enc = new ResponsesSseEncoder({ genId: seqIdGen(), now: fixedNow });
    enc.encode({ type: 'response_created', model: 'm' });
    enc.encode({ type: 'output_item_start', item: { kind: 'message' } });
    expect(() =>
      enc.encode({ type: 'function_arguments', delta: '{}' }),
    ).toThrow(/requires an open function_call item/);
  });

  it('rejects a terminal event while an item is open', () => {
    const enc = new ResponsesSseEncoder({ genId: seqIdGen(), now: fixedNow });
    enc.encode({ type: 'response_created', model: 'm' });
    enc.encode({ type: 'output_item_start', item: { kind: 'message' } });
    expect(() =>
      enc.encode({ type: 'response_done', status: 'completed' }),
    ).toThrow(/still open/);
  });

  it('rejects events after the terminal event', () => {
    const enc = new ResponsesSseEncoder({ genId: seqIdGen(), now: fixedNow });
    enc.encode({ type: 'response_created', model: 'm' });
    enc.encode({ type: 'response_done', status: 'completed' });
    expect(enc.finished).toBe(true);
    expect(() =>
      enc.encode({ type: 'output_item_start', item: { kind: 'message' } }),
    ).toThrow(/no events may follow/);
  });

  it('rejects output_item_stop with no open item', () => {
    const enc = new ResponsesSseEncoder({ genId: seqIdGen(), now: fixedNow });
    enc.encode({ type: 'response_created', model: 'm' });
    expect(() => enc.encode({ type: 'output_item_stop' })).toThrow(
      /no open item/,
    );
  });

  it('encodeResponsesStream requires a terminal event', () => {
    expect(() =>
      encodeResponsesStream([{ type: 'response_created', model: 'm' }], {
        genId: seqIdGen(),
        now: fixedNow,
      }),
    ).toThrow(/did not terminate/);
  });
});
