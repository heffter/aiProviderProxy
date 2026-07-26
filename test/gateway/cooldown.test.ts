/**
 * Cooldown routing integration (epic AIPP-10, subtask 10.4; FR-ROUTE-011).
 *
 * A provider that trips its failure threshold is skipped on the next request
 * without an upstream call, and the request is served by the next candidate.
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
import type { Transport } from '../../src/providers/types.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-envkey',
  ZAI_API_KEY: 'zk',
} as NodeJS.ProcessEnv;

const glmOk = JSON.stringify({
  id: 'glm-ok',
  choices: [
    { finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
});

function cascade(models: string[], allowedFails: number): Config {
  const config = defaultConfig();
  config.routing.mode = 'cascade';
  (config.routing.cascade as Record<string, unknown>).enabled = true;
  (config.routing.cascade as Record<string, unknown>).models = models;
  (config.routing.cooldown as Record<string, unknown>).allowedFails =
    allowedFails;
  return config;
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

describe('provider cooldown skip', () => {
  it('skips a cooling provider on the next request without dispatching to it', async () => {
    const calls: Record<string, number> = {};
    const transport: Transport = async (req) => {
      const provider = req.url.includes('anthropic.com') ? 'anthropic' : 'zai';
      calls[provider] = (calls[provider] ?? 0) + 1;
      if (provider === 'anthropic') {
        return { status: 429, headers: {}, body: '{}' };
      }
      return { status: 200, headers: {}, body: glmOk };
    };
    const sinks = new EventSinkRegistry();
    sinks.register({ name: 'noop' });
    const deps: GatewayDeps = {
      // allowedFails=1: a single 429 trips the anthropic cooldown.
      config: cascade(['claude-sonnet-4-5', 'glm-5.2'], 1),
      registry: buildProviderRegistry({ env }),
      transport,
      sinks,
      outbox: new TokemetryOutbox({ database: new Database(':memory:') }),
    };
    const gateway = createGateway(deps);

    // First request: anthropic 429 trips the breaker, glm serves the request.
    const r1 = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(r1.status).toBe(200);
    expect(calls.anthropic).toBe(1);
    expect(calls.zai).toBe(1);

    // Second request: anthropic is cooling and is skipped entirely.
    const r2 = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(r2.status).toBe(200);
    expect(calls.anthropic).toBe(1); // NOT dispatched again
    expect(calls.zai).toBe(2);
  });

  it('returns an overloaded error when the only provider is cooling', async () => {
    const transport: Transport = async () => ({
      status: 429,
      headers: {},
      body: '{}',
    });
    const config = defaultConfig();
    (config.routing.cooldown as Record<string, unknown>).allowedFails = 1;
    const deps: GatewayDeps = {
      config,
      registry: buildProviderRegistry({ env }),
      transport,
      outbox: new TokemetryOutbox({ database: new Database(':memory:') }),
    };
    const gateway = createGateway(deps);
    // First request trips the breaker (429 -> single failure).
    await gateway.handle(messages('claude-sonnet-4-5'));
    // Second: the sole provider is cooling -> overloaded.
    const r2 = await gateway.handle(messages('claude-sonnet-4-5'));
    expect(r2.status).toBe(529);
  });
});
