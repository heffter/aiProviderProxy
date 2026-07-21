/**
 * Baseline parity integration test / CI safety net (epic AIPP-1, subtask 1.5).
 *
 * Demonstrates the regression gate end to end: a mock upstream stands in for the
 * legacy proxy replaying recorded upstream responses, the parity harness runs
 * over a synthetic corpus, and the job is green. Corrupting a committed fixture
 * (an expected usage number) then turns the job red -- proving the net catches
 * real drift.
 *
 * When the real corpus is captured (subtask 1.3) and the legacy proxy tap is
 * wired, the same harness runs against `src/standalone-proxy.ts` booted over
 * mock upstreams; this test locks in the mechanism today.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCorpusCase, writeCorpusCase } from '../fixtures/tools/corpus.js';
import { fromCorpusCase, runParity, type ReplayTarget } from './harness.js';
import type { RawCapture } from '../fixtures/tools/recorder.js';

let corpusDir: string;
let server: Server;

afterEach(() => {
  server?.close();
  if (corpusDir) {
    rmSync(corpusDir, { recursive: true, force: true });
  }
});

const anthropicCapture: RawCapture = {
  route: '/v1/messages',
  provider: 'anthropic',
  request: {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: { model: 'claude-sonnet-4', messages: [{ role: 'user', content: [{ type: 'text', text: 'the prompt' }] }] },
  },
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      id: 'msg_recorded',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'the recorded answer' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  },
};

const streamCapture: RawCapture = {
  route: '/v1/chat/completions',
  provider: 'openai-chat',
  request: {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: { model: 'gpt-4o', stream: true },
  },
  streamEvents: [
    { event: 'message_start', data: { type: 'message_start' } },
    { event: 'content_block_delta', data: { type: 'text_delta', text: 'Hello' } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ],
};

/** Mock upstream standing in for the legacy proxy replaying recorded responses. */
async function startMockProxy(): Promise<string> {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_live' });
      res.end(
        JSON.stringify({
          id: 'msg_live_777',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'a freshly generated answer' }], // different text, same shape
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      );
      return;
    }
    // streaming chat completions
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"text_delta","text":"Hi there"}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('baseline parity CI gate', () => {
  it('is green when the target matches the recorded corpus', async () => {
    corpusDir = mkdtempSync(join(tmpdir(), 'aipp-baseline-'));
    writeCorpusCase(corpusDir, 'anthropic', 'plain-text', anthropicCapture);
    writeCorpusCase(corpusDir, 'openai-chat', 'stream-text', streamCapture);
    const baseUrl = await startMockProxy();

    const cases = [
      readCorpusCase('anthropic', join(corpusDir, 'anthropic', 'plain-text')),
      readCorpusCase('openai-chat', join(corpusDir, 'openai-chat', 'stream-text')),
    ].map(fromCorpusCase);

    const target: ReplayTarget = { name: 'legacy-proxy', baseUrl };
    const report = await runParity(target, cases);

    expect(report.ok).toBe(true);
    expect(report.okCases).toBe(2);
  });

  it('goes red when a committed fixture is corrupted (usage drift)', async () => {
    corpusDir = mkdtempSync(join(tmpdir(), 'aipp-baseline-'));
    writeCorpusCase(corpusDir, 'anthropic', 'plain-text', anthropicCapture);
    const baseUrl = await startMockProxy();

    // Corrupt the recorded expectation: change an expected usage number.
    const respPath = join(corpusDir, 'anthropic', 'plain-text', 'response.json');
    const corrupted = JSON.parse(readFileSync(respPath, 'utf8')) as { body: { usage: { output_tokens: number } } };
    corrupted.body.usage.output_tokens = 99;
    writeFileSync(respPath, JSON.stringify(corrupted, null, 2), 'utf8');

    const cases = [fromCorpusCase(readCorpusCase('anthropic', join(corpusDir, 'anthropic', 'plain-text')))];
    const report = await runParity({ name: 'legacy-proxy', baseUrl }, cases);

    expect(report.ok).toBe(false);
    expect(report.cases[0].diffs.some((d) => d.path.includes('output_tokens'))).toBe(true);
  });
});
