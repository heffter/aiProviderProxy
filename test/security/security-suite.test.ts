/**
 * Security test suite (epic AIPP-12, subtask 12.5; NFR-SEC-008).
 *
 * Covers the threat-model scenarios that are executable: request-side DoS
 * (oversized body, deep JSON nesting), malformed upstream stream fuzzing against
 * the SSE parsers, and unauthorized management-endpoint access.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  checkRequestLimits,
  jsonNestingDepth,
  MAX_JSON_DEPTH,
} from '../../src/gateway/limits.js';
import {
  createGateway,
  type GatewayDeps,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { Transport } from '../../src/providers/types.js';
import { parseAnthropicSse } from '../../src/providers/anthropic/adapter.js';

describe('request limits', () => {
  it('measures JSON nesting depth, ignoring brackets inside strings', () => {
    expect(jsonNestingDepth('{"a":1}')).toBe(1);
    expect(jsonNestingDepth('{"a":[{"b":2}]}')).toBe(3);
    expect(jsonNestingDepth('{"s":"[[[not nesting]]]"}')).toBe(1);
  });

  it('rejects an oversized body and deep nesting', () => {
    expect(checkRequestLimits('{}', { maxBytes: 1 }).ok).toBe(false);
    const deep = '['.repeat(200) + ']'.repeat(200);
    expect(checkRequestLimits(deep, { maxDepth: 64 }).ok).toBe(false);
    expect(checkRequestLimits('{"ok":true}').ok).toBe(true);
  });
});

function gateway(limits?: GatewayDeps['limits']) {
  const transport: Transport = async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      id: 'm',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const deps: GatewayDeps = {
    config: defaultConfig(),
    registry: buildProviderRegistry({
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-envkey' } as NodeJS.ProcessEnv,
    }),
    transport,
    outbox: new TokemetryOutbox({ database: new Database(':memory:') }),
    limits,
  };
  return createGateway(deps);
}

function post(body: string): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body,
  };
}

describe('gateway DoS guards', () => {
  it('rejects an oversized request body with a client error', async () => {
    const res = await gateway({ maxBytes: 100 }).handle(
      post(
        JSON.stringify({ model: 'claude-sonnet-4-5', filler: 'x'.repeat(500) }),
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain('exceeds');
  });

  it('rejects a deeply nested request body', async () => {
    const nested = `{"model":"claude-sonnet-4-5","x":${'['.repeat(MAX_JSON_DEPTH + 5)}${']'.repeat(MAX_JSON_DEPTH + 5)}}`;
    const res = await gateway().handle(post(nested));
    expect(res.status).toBe(400);
    expect(res.body).toContain('nesting');
  });

  it('allows a normal request', async () => {
    const res = await gateway().handle(
      post(
        JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    );
    expect(res.status).toBe(200);
  });
});

describe('malformed SSE fuzzing does not crash the parser', () => {
  const fuzz = [
    '',
    'garbage without any structure',
    'data: {not json}\n\n',
    'event: message_start\ndata: \n\n',
    'data: ' + '{"a":'.repeat(500) + '1' + '}'.repeat(500) + '\n\n',
    'event: \ndata: null\n\n',
    '\n\n\n\n',
    'data: [DONE]\n\n',
    'event: ping\r\ndata: {}\r\n\r\n',
    'x'.repeat(100000),
  ];
  for (const [i, input] of fuzz.entries()) {
    it(`survives fuzz input #${i}`, () => {
      expect(() => parseAnthropicSse(input)).not.toThrow();
      expect(Array.isArray(parseAnthropicSse(input))).toBe(true);
    });
  }
});

describe('unauthorized management access is refused', () => {
  it('403s a memory endpoint on a non-loopback deployment without a token', async () => {
    const config = defaultConfig();
    config.mesh.enabled = true;
    config.server.host = '0.0.0.0';
    config.server.accessToken = 'secret';
    const deps: GatewayDeps = {
      config,
      registry: buildProviderRegistry({ env: {} as NodeJS.ProcessEnv }),
    };
    const res = await createGateway(deps).handle({
      method: 'GET',
      url: '/v1/mesh/stats',
      headers: { authorization: 'Bearer wrong-token' },
      body: '',
    });
    expect(res.status).toBe(403);
  });
});
