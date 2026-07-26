/**
 * Live policy-enforcement integration (epic AIPP-10, subtask 10.5; FR-ROUTE-007).
 *
 * With `routing.policy.enforce` on and a matching policy, the routed model is
 * overridden by the policy; with enforcement off it is not.
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
import type { RoutingPolicy } from '../../src/routing/index.js';

const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-envkey' } as NodeJS.ProcessEnv;

const anthropicOk = JSON.stringify({
  id: 'msg_ok',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 1 },
});

const policy: RoutingPolicy = {
  version: 1,
  tasks: { review: { preferred: 'claude-opus-4-6' } },
};

function harness(config: Config, routingPolicy: RoutingPolicy | null) {
  const events: CanonicalUsageEvent[] = [];
  const dispatched: string[] = [];
  const transport: Transport = async (req) => {
    dispatched.push(req.body);
    return { status: 200, headers: { 'request-id': 'r' }, body: anthropicOk };
  };
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onLogicalRequestFinal: (e) => events.push(e),
  });
  const deps: GatewayDeps = {
    config,
    registry: buildProviderRegistry({ env }),
    transport,
    sinks,
    outbox: new TokemetryOutbox({ database: new Database(':memory:') }),
    routingPolicy,
  };
  return { gateway: createGateway(deps), events, dispatched };
}

function messages(): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-aipp-task-type': 'review',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'review this' }],
    }),
  };
}

function enforceConfig(): Config {
  const config = defaultConfig();
  (config.routing.policy as Record<string, unknown>).enforce = true;
  return config;
}

describe('policy enforcement', () => {
  it('overrides the routed model when enforcement is on and a rule matches', async () => {
    const { gateway, events } = harness(enforceConfig(), policy);
    const res = await gateway.handle(messages());
    expect(res.status).toBe(200);
    expect(events[0].routedModel).toBe('claude-opus-4-6');
    expect(events[0].routing.policy).toBe('policy:task_rule');
  });

  it('does not override when enforcement is off', async () => {
    const { gateway, events } = harness(defaultConfig(), policy);
    await gateway.handle(messages());
    expect(events[0].routedModel).toBe('claude-sonnet-4-5');
    expect(events[0].routing.policy).toBe('standard');
  });

  it('does not override when no policy is loaded', async () => {
    const { gateway, events } = harness(enforceConfig(), null);
    await gateway.handle(messages());
    expect(events[0].routedModel).toBe('claude-sonnet-4-5');
  });
});
