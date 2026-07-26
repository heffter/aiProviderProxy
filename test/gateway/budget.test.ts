/**
 * Budget enforcement integration (epic AIPP-11, subtask 11.2).
 *
 * The gateway consults the ledger before dispatch (block on breach) and records
 * spend from lifecycle events via the budget sink.
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
import {
  BudgetManager,
  BudgetSink,
  type BudgetConfig,
} from '../../src/ops/budget/index.js';

const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-envkey' } as NodeJS.ProcessEnv;

const anthropicOk = JSON.stringify({
  id: 'msg_ok',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1_000_000, output_tokens: 0 },
});

function budgetConfig(over: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    enabled: true,
    dailyUsd: 10,
    hourlyUsd: 100,
    perRequestUsd: 100,
    onBreach: 'block',
    downgradeTo: 'claude-sonnet-4-6',
    alertThresholds: [80],
    ...over,
  };
}

function harness(budget: BudgetManager, withSink = false) {
  const events: CanonicalUsageEvent[] = [];
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onLogicalRequestFinal: (e) => events.push(e),
  });
  if (withSink) {
    sinks.register(new BudgetSink(budget));
  }
  const deps: GatewayDeps = {
    config: defaultConfig(),
    registry: buildProviderRegistry({ env }),
    transport: (async () => ({
      status: 200,
      headers: { 'request-id': 'r' },
      body: anthropicOk,
    })) as Transport,
    sinks,
    outbox: new TokemetryOutbox({ database: new Database(':memory:') }),
    budget,
  };
  return { gateway: createGateway(deps), events };
}

function messages(): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  };
}

function newManager(cfg: BudgetConfig): BudgetManager {
  return new BudgetManager(cfg, { database: new Database(':memory:') });
}

describe('budget gate', () => {
  it('blocks a request once the daily ceiling is breached', async () => {
    const budget = newManager(budgetConfig());
    budget.recordSpend(10, 'claude-opus-4-6'); // hit the daily cap
    const { gateway, events } = harness(budget);
    const res = await gateway.handle(messages());
    expect(res.status).toBe(429);
    expect(events[0].outcome).toBe('budget_exceeded');
    expect(events[0].success).toBe(false);
  });

  it('allows the request under a warn action even when breached', async () => {
    const budget = newManager(budgetConfig({ onBreach: 'warn' }));
    budget.recordSpend(10, 'claude-opus-4-6');
    const { gateway, events } = harness(budget);
    const res = await gateway.handle(messages());
    expect(res.status).toBe(200);
    expect(events[0].success).toBe(true);
  });

  it('allows a request under the ceiling', async () => {
    const budget = newManager(budgetConfig());
    const { gateway } = harness(budget);
    const res = await gateway.handle(messages());
    expect(res.status).toBe(200);
  });
});

describe('budget sink records spend from events', () => {
  it('accumulates ledger spend from a completed request', async () => {
    const budget = newManager(budgetConfig({ onBreach: 'warn' }));
    const { gateway } = harness(budget, true);
    await gateway.handle(messages());
    await new Promise((r) => setImmediate(r)); // let the sink queue drain
    // 1M input tokens on sonnet ($3/1M) -> ~$3 recorded.
    expect(budget.getStatus().dailySpend).toBeCloseTo(3, 5);
  });
});
