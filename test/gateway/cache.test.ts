/**
 * Response-cache integration (epic AIPP-11, subtask 11.4).
 *
 * A deterministic request is replayed from cache without an upstream call, and
 * the cache-hit event is excluded from Tokemetry export.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  createGateway,
  type GatewayDeps,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import { EventSinkRegistry } from '../../src/lifecycle/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { Transport } from '../../src/providers/types.js';
import { ResponseCache } from '../../src/ops/cache/index.js';

const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-envkey' } as NodeJS.ProcessEnv;

const anthropicOk = JSON.stringify({
  id: 'msg_ok',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 1 },
});

function harness(cache: ResponseCache) {
  const events: CanonicalUsageEvent[] = [];
  let calls = 0;
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onLogicalRequestFinal: (e) => {
      events.push(e);
    },
  });
  const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
  const deps: GatewayDeps = {
    config: defaultConfig(),
    registry: buildProviderRegistry({ env }),
    transport: (async () => {
      calls += 1;
      return { status: 200, headers: { 'request-id': 'r' }, body: anthropicOk };
    }) as Transport,
    sinks,
    outbox,
    cache,
  };
  return { gateway: createGateway(deps), events, outbox, calls: () => calls };
}

function messages(extra: Record<string, unknown> = {}): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    }),
  };
}

function cache() {
  return new ResponseCache(
    {
      enabled: true,
      maxSizeMb: 100,
      defaultTtlSeconds: 3600,
      onlyWhenDeterministic: true,
    },
    { database: new Database(':memory:') },
  );
}

describe('response cache', () => {
  it('replays a deterministic request from cache without dispatching', async () => {
    const { gateway, events, outbox, calls } = harness(cache());

    const r1 = await gateway.handle(messages());
    expect(r1.status).toBe(200);
    expect(r1.headers['x-aipp-cache']).toBeUndefined(); // miss

    const r2 = await gateway.handle(messages());
    expect(r2.status).toBe(200);
    expect(r2.headers['x-aipp-cache']).toBe('hit');
    expect(JSON.parse(r2.body)).toEqual(JSON.parse(anthropicOk));

    // Upstream was called once (the miss); the hit replayed locally.
    expect(calls()).toBe(1);

    // Two logical events (miss + hit), but the hit is excluded from export.
    expect(events).toHaveLength(2);
    expect(events[1].outcome).toBe('cache_hit');
    expect(outbox.counts().pending).toBe(1); // only the miss was enqueued
  });

  it('does not cache a non-deterministic request', async () => {
    const { gateway, calls } = harness(cache());
    await gateway.handle(messages({ temperature: 0.9 }));
    await gateway.handle(messages({ temperature: 0.9 }));
    expect(calls()).toBe(2); // both dispatched; no cache
  });
});
