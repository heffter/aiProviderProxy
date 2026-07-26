/**
 * Routing integration tests (epic AIPP-10, subtask 10.1).
 *
 * Drives the full gateway pipeline and asserts the routing decision reaches the
 * lifecycle: every attempt records a `routing.policy`/`reason`, and a
 * complexity-mode config re-selects the primary provider/model for a complex
 * prompt (translated path), with the tiered model dispatched upstream.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  createGateway,
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

function harness(transport: Transport, config: Config = defaultConfig()) {
  const events: CanonicalUsageEvent[] = [];
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onLogicalRequestFinal: (e) => {
      events.push(e);
    },
  });
  const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
  const gateway = createGateway({
    config,
    registry: buildProviderRegistry({ env }),
    transport,
    sinks,
    outbox,
  });
  return { gateway, events };
}

function messages(model: string, text: string): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content: text }],
    }),
  };
}

const anthropicOk = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 1 },
};

describe('routing metadata on the usage event', () => {
  it('records the standard policy on every attempt by default', async () => {
    const { gateway, events } = harness(async () => ({
      status: 200,
      headers: { 'request-id': 'r1' },
      body: JSON.stringify(anthropicOk),
    }));
    const res = await gateway.handle(messages('claude-sonnet-4-5', 'hi'));
    expect(res.status).toBe(200);
    expect(events[0].routing).toMatchObject({
      policy: 'standard',
      reason: 'standard',
      attemptIndex: 0,
    });
    expect(events[0].provider).toBe('anthropic');
  });
});

describe('complexity mode re-selects the primary', () => {
  function complexityConfig(): Config {
    const config = defaultConfig();
    config.routing.mode = 'complexity';
    (config.routing.complexity as Record<string, unknown>).enabled = true;
    (config.routing.complexity as Record<string, unknown>).complex = 'glm-5.2';
    (config.routing.complexity as Record<string, unknown>).simple =
      'claude-sonnet-4-5';
    return config;
  }

  it('routes a complex prompt to the configured complex-tier model', async () => {
    let dispatched: string | undefined;
    const { gateway, events } = harness(async (req) => {
      dispatched = req.url;
      return {
        status: 200,
        headers: { 'x-request-id': 'zid' },
        // Z.ai speaks chat.completions; the translated Messages path parses this.
        body: JSON.stringify({
          id: 'glm-x',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'ok' },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      };
    }, complexityConfig());

    const res = await gateway.handle(
      messages(
        'claude-sonnet-4-5',
        'design a distributed system architecture and implement it',
      ),
    );
    expect(res.status).toBe(200);
    expect(dispatched).toContain('z.ai'); // routed to the Z.ai upstream
    expect(events[0]).toMatchObject({
      provider: 'zai',
      routedModel: 'glm-5.2',
      requestedModel: 'claude-sonnet-4-5',
    });
    expect(events[0].routing.reason).toBe('complexity:complex');
  });

  it('keeps a simple prompt on the simple-tier model', async () => {
    const { gateway, events } = harness(
      async () => ({
        status: 200,
        headers: { 'request-id': 'r2' },
        body: JSON.stringify(anthropicOk),
      }),
      complexityConfig(),
    );
    await gateway.handle(messages('claude-sonnet-4-5', 'hi'));
    expect(events[0].provider).toBe('anthropic');
    expect(events[0].routing.reason).toBe('complexity:simple');
  });
});
