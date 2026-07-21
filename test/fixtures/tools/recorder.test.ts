/**
 * Unit tests for the fixture recorder (epic AIPP-1, subtask 1.2).
 *
 * Covers the opt-in recording gate, deterministic file naming, SSE event
 * ordering preservation, and a full round-trip against a mock upstream HTTP
 * server proving the persisted fixture carries no raw content or secrets.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFixture,
  getFixtureDir,
  isRecordingEnabled,
  recordFixture,
  RECORD_ENV_VAR,
  type Fixture,
  type RawCapture,
} from './recorder.js';

const PROMPT = 'CONTENTTOKEN_migrate_database_prompt';
const COMPLETION = 'CONTENTTOKEN_model_generated_reply';
const BEARER = 'Bearer abcDEF123.ghiJKL456-mnoPQR789';
const API_KEY = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1111';

let workDir: string;
const savedEnv = process.env[RECORD_ENV_VAR];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aipp-fixtures-'));
  delete process.env[RECORD_ENV_VAR];
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (savedEnv === undefined) {
    delete process.env[RECORD_ENV_VAR];
  } else {
    process.env[RECORD_ENV_VAR] = savedEnv;
  }
});

afterAll(() => {
  if (savedEnv === undefined) {
    delete process.env[RECORD_ENV_VAR];
  } else {
    process.env[RECORD_ENV_VAR] = savedEnv;
  }
});

describe('recording gate', () => {
  it('is disabled unless AIPP_RECORD_FIXTURES is set', () => {
    expect(getFixtureDir()).toBeNull();
    expect(isRecordingEnabled()).toBe(false);
  });

  it('reflects the configured directory when set', () => {
    process.env[RECORD_ENV_VAR] = workDir;
    expect(getFixtureDir()).toBe(workDir);
    expect(isRecordingEnabled()).toBe(true);
  });

  it('recordFixture is a no-op returning null when disabled', () => {
    const capture: RawCapture = {
      route: '/v1/messages',
      request: { method: 'POST', url: '/v1/messages', body: { messages: [] } },
    };
    expect(recordFixture(capture, null)).toBeNull();
    expect(recordFixture(capture)).toBeNull(); // env unset
  });
});

describe('buildFixture', () => {
  it('scrubs content and secrets while preserving usage numbers', () => {
    const fixture = buildFixture({
      route: '/v1/messages',
      provider: 'anthropic',
      request: {
        method: 'POST',
        url: '/v1/messages?beta=true',
        headers: { 'content-type': 'application/json', authorization: BEARER },
        body: { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: PROMPT }] },
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { content: [{ type: 'text', text: COMPLETION }], usage: { input_tokens: 100, output_tokens: 25 } },
      },
      usage: { input_tokens: 100, output_tokens: 25 },
    });

    const serialized = JSON.stringify(fixture);
    expect(serialized).not.toContain(PROMPT);
    expect(serialized).not.toContain(COMPLETION);
    expect(serialized).not.toContain('sk-ant-');
    expect(serialized).not.toContain('Bearer');

    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.request.url).toBe('/v1/messages'); // query stripped
    expect(fixture.request.headers).toEqual({ 'content-type': 'application/json' }); // auth dropped
    expect((fixture.usage as { input_tokens: number }).input_tokens).toBe(100);
  });

  it('preserves SSE event ordering while scrubbing deltas', () => {
    const fixture = buildFixture({
      route: '/v1/chat/completions',
      request: { method: 'POST', url: '/v1/chat/completions', body: {} },
      streamEvents: [
        { event: 'message_start', data: { type: 'message_start' } },
        { event: 'content_block_delta', data: { type: 'text_delta', text: 'Hello ' } },
        { event: 'content_block_delta', data: { type: 'text_delta', text: 'world' } },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 5 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });

    expect(fixture.streamEvents?.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_delta',
      'content_block_delta',
      'message_delta',
      'message_stop',
    ]);
    const delta = fixture.streamEvents?.[1].data as { type: string; text: string };
    expect(delta.type).toBe('text_delta'); // structure preserved
    expect(delta.text).not.toContain('Hello'); // content scrubbed
    const usageEvent = fixture.streamEvents?.[3].data as { usage: { output_tokens: number } };
    expect(usageEvent.usage.output_tokens).toBe(5); // usage number preserved
  });
});

describe('deterministic naming', () => {
  it('re-recording the same capture writes the same file', () => {
    const capture: RawCapture = {
      route: '/v1/messages',
      request: { method: 'POST', url: '/v1/messages', body: { messages: [{ role: 'user', content: PROMPT }] } },
    };
    const first = recordFixture(capture, workDir);
    const second = recordFixture(capture, workDir);
    expect(first).not.toBeNull();
    expect(first).toBe(second);
    expect(existsSync(first as string)).toBe(true);
    expect((first as string).endsWith('.json')).toBe(true);
  });
});

describe('round-trip against a mock upstream', () => {
  let server: Server;
  let port: number;

  async function startServer(): Promise<void> {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_upstream_123' });
        res.end(
          JSON.stringify({
            id: 'msg_123',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-20250514',
            content: [{ type: 'text', text: COMPLETION }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 25 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }

  function post(
    path: string,
    headers: Record<string, string>,
    bodyObj: unknown,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(bodyObj);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(data) },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(buf) }));
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  afterEach(() => {
    server?.close();
  });

  it('records a real exchange with no content or secrets on disk', async () => {
    await startServer();

    const requestHeaders = {
      'content-type': 'application/json',
      authorization: BEARER,
      'x-api-key': API_KEY,
    };
    const requestBody = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    };
    const response = await post('/v1/messages?beta=true', requestHeaders, requestBody);

    const capture: RawCapture = {
      route: '/v1/messages',
      provider: 'anthropic',
      request: { method: 'POST', url: '/v1/messages?beta=true', headers: requestHeaders, body: requestBody },
      response: { status: response.status, headers: response.headers, body: response.body },
      usage: (response.body as { usage: unknown }).usage,
    };

    const file = recordFixture(capture, workDir);
    expect(file).not.toBeNull();

    const raw = readFileSync(file as string, 'utf8');
    for (const leak of [PROMPT, COMPLETION, BEARER, API_KEY, 'sk-ant-']) {
      expect(raw, `fixture must not contain ${leak}`).not.toContain(leak);
    }

    const fixture = JSON.parse(raw) as Fixture;
    expect(fixture.request.url).toBe('/v1/messages'); // query stripped
    expect(fixture.request.headers).toEqual({ 'content-type': 'application/json' }); // auth + x-api-key dropped
    expect(fixture.response?.status).toBe(200);
    expect((fixture.response?.body as { usage: { input_tokens: number } }).usage.input_tokens).toBe(100);
    expect((fixture.usage as { output_tokens: number }).output_tokens).toBe(25);
  });
});
