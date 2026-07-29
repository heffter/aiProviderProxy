/**
 * Multi-attempt routing tests (epic AIPP-10, subtask 10.2;
 * FR-ROUTE-004/006/012/013/014).
 *
 * Drives the Messages surface through the three structured-attempt scenarios --
 * 429 reliability cascade, budget downgrade, and 401 account rotation -- and
 * asserts one lifecycle event per attempt with correct linkage
 * (attemptIndex, fallbackFrom, fallbackTrigger). Also exercises the routing-log
 * v2 sink (one record per attempt) and the Tokemetry routing block.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createGateway,
  type GatewayDeps,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import type { Config } from '../../src/config/index.js';
import { EventSinkRegistry } from '../../src/lifecycle/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type {
  Transport,
  TransportResponse,
} from '../../src/providers/types.js';
import {
  RoutingLogSink,
  type RoutingLogRecord,
} from '../../src/ops/trackers/routing-log-sink.js';
import { mapToIngest } from '../../src/integrations/tokemetry/mapper.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-envkey',
  ZAI_API_KEY: 'zk',
} as NodeJS.ProcessEnv;

interface HarnessExtra {
  config?: Config;
  budgetPercent?: () => number;
  accountsFor?: (provider: string) => string[];
  sinks?: EventSinkRegistry;
}

function harness(transport: Transport, extra: HarnessExtra = {}) {
  const attempts: CanonicalUsageEvent[] = [];
  const finals: CanonicalUsageEvent[] = [];
  const sinks = extra.sinks ?? new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onAttemptFinal: (e) => {
      attempts.push(e);
    },
    onLogicalRequestFinal: (e) => {
      finals.push(e);
    },
  });
  const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
  const deps: GatewayDeps = {
    config: extra.config ?? defaultConfig(),
    registry: buildProviderRegistry({ env }),
    transport,
    sinks,
    outbox,
    budgetPercent: extra.budgetPercent,
    accountsFor: extra.accountsFor,
  };
  return { gateway: createGateway(deps), attempts, finals, sinks };
}

function messages(
  model: string,
  extra: Record<string, unknown> = {},
): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    }),
  };
}

const anthropicOk = JSON.stringify({
  id: 'msg_ok',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 1 },
});

const glmOk = JSON.stringify({
  id: 'glm-ok',
  choices: [
    { finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
});

function cascadeConfig(models: string[]): Config {
  const config = defaultConfig();
  config.routing.mode = 'cascade';
  (config.routing.cascade as Record<string, unknown>).enabled = true;
  (config.routing.cascade as Record<string, unknown>).models = models;
  return config;
}

describe('429 reliability cascade', () => {
  it('falls back to the next provider and links the hop', async () => {
    const { gateway, attempts, finals } = harness(
      async (req): Promise<TransportResponse> => {
        if (req.url.includes('anthropic.com')) {
          return { status: 429, headers: {}, body: '{"error":{}}' };
        }
        return { status: 200, headers: { 'x-request-id': 'zid' }, body: glmOk };
      },
      { config: cascadeConfig(['claude-sonnet-4-5', 'glm-5.2']) },
    );

    const res = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(res.status).toBe(200);

    // One superseded attempt, one terminal (winning) event.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      provider: 'anthropic',
      outcome: 'provider_rate_limited',
      httpStatus: 429,
      success: false,
    });
    expect(attempts[0].routing.attemptIndex).toBe(0);
    expect(attempts[0].routing.fallbackTrigger).toBeUndefined();

    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ provider: 'zai', success: true });
    expect(finals[0].routing).toMatchObject({
      attemptIndex: 1,
      fallbackFrom: 'claude-sonnet-4-5',
      fallbackTrigger: 'reliability',
    });
  });

  it('exposes the routing block on the Tokemetry v2 event', async () => {
    const { gateway, finals } = harness(
      async (req) =>
        req.url.includes('anthropic.com')
          ? { status: 503, headers: {}, body: '{}' }
          : { status: 200, headers: {}, body: glmOk },
      { config: cascadeConfig(['claude-sonnet-4-5', 'glm-5.2']) },
    );
    await gateway.handle(messages('claude-sonnet-4-5'));
    const ingest = mapToIngest(finals[0], { proxyVersion: 'test' });
    expect(ingest.routing).toMatchObject({
      fallback_trigger: 'reliability',
      fallback_from: 'claude-sonnet-4-5',
    });
  });
});

describe('budget downgrade', () => {
  function downgradeConfig(): Config {
    const config = defaultConfig();
    (config.routing.downgrade as Record<string, unknown>).enabled = true;
    (config.routing.downgrade as Record<string, unknown>).mapping = {
      'claude-opus-4-6': 'claude-sonnet-4-6',
    };
    return config;
  }

  it('swaps to the cheaper model and marks the response + event', async () => {
    let dispatchedBody: string | undefined;
    const { gateway, attempts, finals } = harness(
      async (req) => {
        dispatchedBody = req.body;
        return {
          status: 200,
          headers: { 'request-id': 'r' },
          body: anthropicOk,
        };
      },
      { config: downgradeConfig(), budgetPercent: () => 90 },
    );

    const res = await gateway.handle(messages('claude-opus-4-6'));
    expect(res.status).toBe(200);
    expect(res.headers['x-aipp-downgraded']).toBe('true');
    expect(res.headers['x-aipp-original-model']).toBe('claude-opus-4-6');
    expect(dispatchedBody).toContain('claude-sonnet-4-6'); // cheaper model sent

    // Single attempt (downgrade is a pre-dispatch swap, not a hop).
    expect(attempts).toHaveLength(0);
    expect(finals).toHaveLength(1);
    expect(finals[0].routedModel).toBe('claude-sonnet-4-6');
    expect(finals[0].routing).toMatchObject({
      attemptIndex: 0,
      fallbackFrom: 'claude-opus-4-6',
      fallbackTrigger: 'downgrade',
    });
  });

  it('does not downgrade below the threshold', async () => {
    const { gateway, finals } = harness(
      async () => ({ status: 200, headers: {}, body: anthropicOk }),
      { config: downgradeConfig(), budgetPercent: () => 50 },
    );
    const res = await gateway.handle(messages('claude-opus-4-6'));
    expect(res.headers['x-aipp-downgraded']).toBeUndefined();
    expect(finals[0].routing.fallbackTrigger).toBeUndefined();
  });
});

describe('401 account rotation', () => {
  it('rotates to the next account of the same provider and links it', async () => {
    let calls = 0;
    const { gateway, attempts, finals } = harness(
      async (): Promise<TransportResponse> => {
        calls += 1;
        return calls === 1
          ? { status: 401, headers: {}, body: '{"error":{}}' }
          : { status: 200, headers: { 'request-id': 'r' }, body: anthropicOk };
      },
      { accountsFor: (p) => (p === 'anthropic' ? ['acct-a', 'acct-b'] : []) },
    );

    const res = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(res.status).toBe(200);
    expect(calls).toBe(2);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      provider: 'anthropic',
      outcome: 'provider_auth_error',
    });
    expect(attempts[0].routing.accountLabel).toBe('acct-a');

    expect(finals).toHaveLength(1);
    expect(finals[0].routing).toMatchObject({
      attemptIndex: 1,
      accountLabel: 'acct-b',
      fallbackFrom: 'claude-sonnet-4-5',
      fallbackTrigger: 'rotation',
    });
  });

  it('is terminal when no further account is available', async () => {
    const { gateway, attempts, finals } = harness(
      async () => ({ status: 401, headers: {}, body: '{"error":{}}' }),
      { accountsFor: () => ['only-one'] },
    );
    const res = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(res.status).toBe(401);
    expect(attempts).toHaveLength(0); // no superseded hop
    expect(finals).toHaveLength(1);
    expect(finals[0].success).toBe(false);
  });
});

describe('routing-log v2 sink', () => {
  it('writes one record per attempt with linkage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipp-routelog-'));
    try {
      const sinks = new EventSinkRegistry();
      sinks.register(new RoutingLogSink({ dir }));
      const { gateway } = harness(
        async (req) =>
          req.url.includes('anthropic.com')
            ? { status: 429, headers: {}, body: '{}' }
            : { status: 200, headers: {}, body: glmOk },
        { config: cascadeConfig(['claude-sonnet-4-5', 'glm-5.2']), sinks },
      );
      await gateway.handle(messages('claude-sonnet-4-5'));
      await sinks.drain();

      const path = join(dir, 'routing-log.jsonl');
      const lines = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as RoutingLogRecord);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        schemaVersion: 2,
        provider: 'anthropic',
        attemptIndex: 0,
        outcome: 'provider_rate_limited',
        success: false,
      });
      expect(lines[1]).toMatchObject({
        schemaVersion: 2,
        provider: 'zai',
        attemptIndex: 1,
        fallbackTrigger: 'reliability',
        fallbackFrom: 'claude-sonnet-4-5',
        success: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
