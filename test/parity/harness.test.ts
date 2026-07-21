/**
 * Unit tests for the replay/parity harness (epic AIPP-1, subtask 1.4).
 *
 * Uses synthetic fixtures with deliberate mismatches to prove the harness
 * accepts benign variation (ids, timestamps, latency, exact content) while
 * catching real divergence (usage numbers, stop reasons, event ordering).
 * Includes a full replay against a mock upstream.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { compareCase, parseSse, replayCase, runParity, type ParityCase, type ReplayResult } from './harness.js';

const baseExpected: ParityCase = {
  name: 'anthropic/plain-text',
  request: { method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' }, body: { model: 'claude-sonnet-4' } },
  expectedResponse: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      id: 'msg_expected',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '<scrubbed:12:aaaaaaaa>' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  },
};

// A live-looking response: different id, real (unscrubbed) content, volatile headers.
function liveResult(overrides: Partial<{ body: unknown; status: number }> = {}): ReplayResult {
  return {
    status: overrides.status ?? 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_live_999', date: 'now' },
    body: overrides.body ?? {
      id: 'msg_live_999',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'completely different generated text' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  };
}

describe('compareCase benign variation', () => {
  it('passes when only ids, content text and volatile headers differ', () => {
    const result = compareCase(baseExpected, liveResult());
    expect(result.ok).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});

describe('compareCase real divergence', () => {
  it('fails on a usage-number difference', () => {
    const result = compareCase(
      baseExpected,
      liveResult({
        body: {
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'x' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 }, // 4 -> 5
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => d.path.includes('output_tokens') && d.kind === 'changed')).toBe(true);
  });

  it('fails on a changed stop_reason', () => {
    const result = compareCase(
      baseExpected,
      liveResult({
        body: {
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'x' }],
          stop_reason: 'max_tokens', // end_turn -> max_tokens
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => d.path.includes('stop_reason'))).toBe(true);
  });

  it('fails on reordered SSE events', () => {
    const streamCase: ParityCase = {
      name: 'openai-chat/stream',
      request: { method: 'POST', url: '/v1/chat/completions', body: {} },
      expectedStream: [
        { event: 'message_start', data: { type: 'message_start' } },
        { event: 'content_block_delta', data: { type: 'text_delta', text: '<scrubbed:5:aaaaaaaa>' } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    };
    const reordered: ReplayResult = {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      streamEvents: [
        { event: 'message_start', data: { type: 'message_start' } },
        { event: 'message_stop', data: { type: 'message_stop' } }, // swapped
        { event: 'content_block_delta', data: { type: 'text_delta', text: 'hi' } },
      ],
    };
    const result = compareCase(streamCase, reordered);
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => d.path.startsWith('$.stream'))).toBe(true);
  });
});

describe('parseSse', () => {
  it('parses Anthropic-style event+data blocks', () => {
    const raw = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    expect(parseSse(raw).map((e) => e.event)).toEqual(['message_start', 'message_stop']);
  });

  it('parses OpenAI-style data-only stream with [DONE]', () => {
    const raw = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const events = parseSse(raw);
    expect(events[events.length - 1].event).toBe('done');
  });
});

describe('replay against a mock upstream', () => {
  let server: Server;
  const cannedBody = {
    id: 'msg_srv',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'server generated answer' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 4 },
  };

  afterEach(() => {
    server?.close();
  });

  async function start(): Promise<string> {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_srv' });
      res.end(JSON.stringify(cannedBody));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('replays a request and reports parity pass for a matching expectation', async () => {
    const baseUrl = await start();
    const captured = await replayCase({ name: 'legacy', baseUrl }, baseExpected);
    expect(captured.status).toBe(200);

    const report = await runParity({ name: 'legacy', baseUrl }, [baseExpected]);
    expect(report.ok).toBe(true);
    expect(report.okCases).toBe(1);
  });

  it('reports parity fail when the expectation disagrees on usage', async () => {
    const baseUrl = await start();
    const mismatched: ParityCase = {
      ...baseExpected,
      name: 'anthropic/usage-mismatch',
      expectedResponse: {
        ...baseExpected.expectedResponse!,
        body: { ...baseExpected.expectedResponse!.body as object, usage: { input_tokens: 10, output_tokens: 99 } },
      },
    };
    const report = await runParity({ name: 'legacy', baseUrl }, [mismatched]);
    expect(report.ok).toBe(false);
    expect(report.cases[0].diffs.some((d) => d.path.includes('output_tokens'))).toBe(true);
  });
});
