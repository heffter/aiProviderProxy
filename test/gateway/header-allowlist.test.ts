/**
 * Header-allowlist regression (epic AIPP-12, subtask 12.2; NFR-SEC-005).
 *
 * Adapters build a clean upstream header set by construction; arbitrary client
 * headers (cookies, host, forwarded-for, rogue x-* headers) must never be
 * forwarded to the provider, and response headers exposed to the client are
 * likewise a small allowlist.
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
import type { Transport, TransportRequest } from '../../src/providers/types.js';

const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-envkey' } as NodeJS.ProcessEnv;

const anthropicOk = JSON.stringify({
  id: 'msg_ok',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
});

function harness() {
  let captured: TransportRequest | undefined;
  const transport: Transport = async (req) => {
    captured = req;
    return {
      status: 200,
      headers: {
        'request-id': 'r',
        'set-cookie': 'session=leak', // upstream header that must NOT be exposed
        'x-internal-trace': 'secret',
      },
      body: anthropicOk,
    };
  };
  const deps: GatewayDeps = {
    config: defaultConfig(),
    registry: buildProviderRegistry({ env }),
    transport,
    sinks: new EventSinkRegistry(),
    outbox: new TokemetryOutbox({ database: new Database(':memory:') }),
  };
  return { gateway: createGateway(deps), captured: () => captured };
}

function messages(headers: Record<string, string>): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  };
}

describe('upstream header allowlist', () => {
  it('does not forward rogue client headers to the provider', async () => {
    const { gateway, captured } = harness();
    await gateway.handle(
      messages({
        cookie: 'session=abc',
        host: 'evil.example.com',
        'x-forwarded-for': '10.0.0.1',
        'x-evil-header': 'boom',
        'x-real-ip': '1.2.3.4',
      }),
    );
    const sent = captured();
    expect(sent).toBeDefined();
    const keys = Object.keys(sent!.headers).map((k) => k.toLowerCase());
    for (const rogue of [
      'cookie',
      'host',
      'x-forwarded-for',
      'x-evil-header',
      'x-real-ip',
    ]) {
      expect(keys, `${rogue} must be dropped`).not.toContain(rogue);
    }
  });
});

describe('response header allowlist', () => {
  it('does not leak upstream response headers to the client', async () => {
    const { gateway } = harness();
    const res = await gateway.handle(messages({}));
    const keys = Object.keys(res.headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain('set-cookie');
    expect(keys).not.toContain('x-internal-trace');
    // Only the explicit gateway response headers are present.
    expect(keys).toContain('content-type');
  });
});
