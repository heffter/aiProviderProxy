/**
 * Contract tests for the mock Tokemetry ingest server (epic AIPP-5, subtask 5.4).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import {
  MockIngestServer,
  INGEST_ENDPOINT_PATH,
} from './mock-ingest-server.js';
import type { TransportRequest } from '../../../src/providers/types.js';

const TOKEN = 'secret-token';

function post(body: unknown, auth = `Bearer ${TOKEN}`): TransportRequest {
  return {
    url: INGEST_ENDPOINT_PATH,
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const validEvent = (event_id: string, sequence = 0, finality = 'final') => ({
  event_id,
  sequence,
  finality,
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 0,
});

describe('auth and routing', () => {
  it('requires the bearer token and a known route', () => {
    const server = new MockIngestServer({ token: TOKEN });
    expect(server.handle(post({ events: [] }, 'Bearer wrong')).status).toBe(
      401,
    );
    expect(
      server.handle({
        url: '/nope',
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      }).status,
    ).toBe(404);
  });
});

describe('batch validation (all-or-nothing) and keep-max', () => {
  it('accepts a valid batch and keeps the max sequence per event_id', () => {
    const server = new MockIngestServer({ token: TOKEN });
    expect(
      server.handle(
        post({
          events: [
            validEvent('e1', 0),
            validEvent('e1', 2),
            validEvent('e2', 0),
          ],
        }),
      ).status,
    ).toBe(200);
    const stored = server.events();
    expect(stored).toHaveLength(2);
    expect(stored.find((e) => e.event_id === 'e1')?.sequence).toBe(2);
  });

  it('rejects the whole batch on a negative token count (nothing stored)', () => {
    const server = new MockIngestServer({ token: TOKEN });
    const res = server.handle(
      post({
        events: [validEvent('ok'), { ...validEvent('bad'), output_tokens: -1 }],
      }),
    );
    expect(res.status).toBe(400);
    expect(server.events()).toHaveLength(0); // all-or-nothing
  });

  it('rejects a client-supplied cost_usd (server computes cost)', () => {
    const server = new MockIngestServer({ token: TOKEN });
    expect(
      server.handle(post({ events: [{ ...validEvent('e'), cost_usd: 0.01 }] }))
        .status,
    ).toBe(400);
  });
});

describe('failure injection', () => {
  it('returns the injected status for N calls, then succeeds', () => {
    const server = new MockIngestServer({ token: TOKEN });
    server.injectFailures(2, 503);
    expect(server.handle(post({ events: [validEvent('e')] })).status).toBe(503);
    expect(server.handle(post({ events: [validEvent('e')] })).status).toBe(503);
    expect(server.handle(post({ events: [validEvent('e')] })).status).toBe(200);
  });
});

describe('real HTTP server', () => {
  let server: MockIngestServer;
  afterEach(() => server?.stop());

  it('accepts a batch over HTTP', async () => {
    server = new MockIngestServer({ token: TOKEN });
    const baseUrl = await server.start();
    const status = await new Promise<number>((resolve, reject) => {
      const data = JSON.stringify({ events: [validEvent('http-1')] });
      const req = httpRequest(
        `${baseUrl}${INGEST_ENDPOINT_PATH}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-length': Buffer.byteLength(data),
          },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(status).toBe(200);
    expect(server.events().map((e) => e.event_id)).toEqual(['http-1']);
  });
});
