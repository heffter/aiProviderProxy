/**
 * Pre-stream retry integration tests (epic AIPP-10, subtask 10.3).
 *
 * Drives the Messages surface with a transport that fails transiently and
 * asserts the bounded backoff schedule, category gating, and fallback handoff
 * once the retry budget is exhausted. Backoff sleeps are injected so the
 * schedule is asserted without real time.
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
import type { Config } from '../../src/config/index.js';
import { EventSinkRegistry } from '../../src/lifecycle/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { Transport } from '../../src/providers/types.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-envkey',
  ZAI_API_KEY: 'zk',
} as NodeJS.ProcessEnv;

function connError(): Error {
  return Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
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

function harness(transport: Transport, config: Config = defaultConfig()) {
  const attempts: CanonicalUsageEvent[] = [];
  const finals: CanonicalUsageEvent[] = [];
  const delays: number[] = [];
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onAttemptFinal: (e) => attempts.push(e),
    onLogicalRequestFinal: (e) => finals.push(e),
  });
  const deps: GatewayDeps = {
    config,
    registry: buildProviderRegistry({ env }),
    transport,
    sinks,
    outbox: new TokemetryOutbox({ database: new Database(':memory:') }),
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
  };
  return { gateway: createGateway(deps), attempts, finals, delays };
}

function messages(model: string): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  };
}

function cascade(models: string[]): Config {
  const config = defaultConfig();
  config.routing.mode = 'cascade';
  (config.routing.cascade as Record<string, unknown>).enabled = true;
  (config.routing.cascade as Record<string, unknown>).models = models;
  return config;
}

describe('pre-stream retry', () => {
  it('retries a connection error with backoff then succeeds', async () => {
    let calls = 0;
    const { gateway, attempts, finals, delays } = harness(async () => {
      calls += 1;
      if (calls < 3) throw connError();
      return { status: 200, headers: { 'request-id': 'r' }, body: anthropicOk };
    });

    const res = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(res.status).toBe(200);
    expect(calls).toBe(3); // 1 initial + 2 retries
    // Exponential backoff with jitter (rand=0.5): 250/2+0.5*125=188, 500/2+... =375.
    expect(delays).toEqual([188, 375]);
    // Two superseded retry attempts, then the winning attempt.
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.outcome)).toEqual([
      'provider_connection_error',
      'provider_connection_error',
    ]);
    expect(attempts.map((a) => a.routing.attemptIndex)).toEqual([0, 1]);
    expect(finals).toHaveLength(1);
    expect(finals[0].success).toBe(true);
    expect(finals[0].routing.attemptIndex).toBe(2);
  });

  it('stops at the retry budget then falls back to the next candidate', async () => {
    const { gateway, finals, delays } = harness(
      async (req) => {
        if (req.url.includes('anthropic.com')) throw connError();
        return { status: 200, headers: {}, body: glmOk };
      },
      cascade(['claude-sonnet-4-5', 'glm-5.2']),
    );

    const res = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(res.status).toBe(200);
    // 2 retries on the primary (delays), then reliability fallback to glm.
    expect(delays).toHaveLength(2);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ provider: 'zai', success: true });
    expect(finals[0].routing.fallbackTrigger).toBe('reliability');
  });

  it('does not retry a validation error (category gating)', async () => {
    const { gateway, attempts, delays } = harness(async () => ({
      status: 400,
      headers: {},
      body: '{"error":{"type":"invalid_request_error"}}',
    }));
    const res = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(res.status).toBe(400);
    expect(delays).toHaveLength(0); // no backoff
    expect(attempts).toHaveLength(0); // terminal on the first attempt
  });

  it('honours a maxRetries of 0 (retry disabled)', async () => {
    const config = defaultConfig();
    (config.routing.retry as Record<string, unknown>).maxRetries = 0;
    const { gateway, delays } = harness(async () => {
      throw connError();
    }, config);
    const res = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(res.status).toBe(500);
    expect(delays).toHaveLength(0);
  });
});
