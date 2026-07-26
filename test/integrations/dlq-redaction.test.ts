/**
 * DLQ + error-path redaction (epic AIPP-12, subtask 12.1; FR-AUTH-004).
 *
 * A planted credential in a failing export payload must be redacted in the
 * stored DLQ record, and an upstream error carrying a secret must not leak into
 * the client-facing error response.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import {
  createGateway,
  type GatewayDeps,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import { EventSinkRegistry } from '../../src/lifecycle/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { Transport } from '../../src/providers/types.js';

const SECRET = 'sk-ant-api03-DEADBEEFdeadbeef012345';

function event(id: string): CanonicalUsageEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    logicalRequestId: 'lr',
    attemptId: 'at',
    eventKind: 'logical_request',
    finality: 'final',
    sequence: 0,
    timestampStarted: '2026-07-26T12:00:00.000Z',
    timestampCompleted: '2026-07-26T12:00:01.000Z',
    clientProtocol: 'anthropic_messages',
    upstreamProtocol: 'anthropic',
    provider: 'anthropic',
    requestedModel: 'm',
    routedModel: 'm',
    nativeModel: 'm',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteShortTokens: 0,
    cacheWriteLongTokens: 0,
    success: false,
    outcome: 'provider_auth_error',
    latencyMs: 1,
    streaming: false,
    toolCallCount: 0,
    routing: { attemptIndex: 0 },
    provenance: 'local_estimate',
    extra: {},
  } as CanonicalUsageEvent;
}

describe('DLQ redaction', () => {
  it('redacts a credential in a dead-lettered error record', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    outbox.enqueue(event('e1'), 1000);
    const batch = outbox.claimBatch(10, 1000);
    outbox.markDead(
      batch.map((r) => r.id),
      `export failed: 401 {"error":"invalid key ${SECRET}"}`,
    );
    const dead = outbox.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].last_error).not.toContain(SECRET);
    expect(dead[0].last_error).toContain('<redacted:secret>');
  });

  it('redacts a credential in a retryable failure record', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    outbox.enqueue(event('e2'), 1000);
    const batch = outbox.claimBatch(10, 1000);
    outbox.markFailed(
      batch.map((r) => r.id),
      0,
      `network error Bearer ${SECRET}`,
    );
    const rows = outbox.claimBatch(10, 5000); // backoff elapsed
    expect(rows[0].last_error).not.toContain(SECRET);
  });
});

describe('error-response redaction', () => {
  it('does not echo an upstream secret into the client error response', async () => {
    const events: CanonicalUsageEvent[] = [];
    const sinks = new EventSinkRegistry();
    sinks.register({
      name: 'capture',
      onLogicalRequestFinal: (e) => events.push(e),
    });
    const transport: Transport = async () => ({
      status: 401,
      headers: {},
      body: JSON.stringify({ error: { message: `bad key ${SECRET}` } }),
    });
    const deps: GatewayDeps = {
      config: defaultConfig(),
      registry: buildProviderRegistry({
        env: { ANTHROPIC_API_KEY: 'sk-ant-api03-envkey' } as NodeJS.ProcessEnv,
      }),
      transport,
      sinks,
    };
    const gateway = createGateway(deps);
    const req: GatewayRequest = {
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    };
    const res = await gateway.handle(req);
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(SECRET); // generic message, no upstream body
  });
});
