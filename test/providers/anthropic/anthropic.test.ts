/**
 * Tests for the Anthropic adapter, auth, and token pool (epic AIPP-4, subtask 4.4).
 */

import { describe, it, expect } from 'vitest';
import {
  buildAnthropicHeaders,
  createAnthropicAdapter,
  extractAnthropicUsage,
  parseAnthropicSse,
  setAnthropicAuth,
  TokenPool,
} from '../../../src/providers/anthropic/index.js';
import type { Transport } from '../../../src/providers/types.js';
import { assertAdapterConformance } from '../conformance.js';

const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-envkey' } as NodeJS.ProcessEnv;

describe('conformance', () => {
  it('passes the adapter contract', () => {
    assertAdapterConformance(createAnthropicAdapter({ env }));
  });
});

describe('setAnthropicAuth', () => {
  it('uses Bearer + oauth beta for OAT tokens', () => {
    const h: Record<string, string> = {};
    setAnthropicAuth(h, 'sk-ant-oat01-abc');
    expect(h.authorization).toBe('Bearer sk-ant-oat01-abc');
    expect(h['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('uses x-api-key for standard keys', () => {
    const h: Record<string, string> = {};
    setAnthropicAuth(h, 'sk-ant-api03-xyz');
    expect(h['x-api-key']).toBe('sk-ant-api03-xyz');
    expect(h.authorization).toBeUndefined();
  });
});

describe('buildAnthropicHeaders', () => {
  it('prefers client passthrough over the fallback key', () => {
    const h = buildAnthropicHeaders(
      { authHeader: 'Bearer sk-ant-oat01-client' },
      'sk-ant-api03-envkey',
    );
    expect(h.authorization).toBe('Bearer sk-ant-oat01-client');
    expect(h['x-api-key']).toBeUndefined();
  });

  it('strips OAT-unsupported beta flags for OAT tokens', () => {
    const h = buildAnthropicHeaders(
      {
        betaHeaders:
          'max-tokens-3-5-sonnet-2025-04-14,prompt-caching-2024-07-31',
        apiKeyHeader: 'sk-ant-oat01-x',
      },
      undefined,
    );
    expect(h['anthropic-beta']).toContain('prompt-caching-2024-07-31');
    expect(h['anthropic-beta']).not.toContain(
      'max-tokens-3-5-sonnet-2025-04-14',
    );
    expect(h['anthropic-beta']).toContain('oauth-2025-04-20');
  });

  it('keeps unsupported flags for standard keys', () => {
    const h = buildAnthropicHeaders(
      {
        betaHeaders: 'max-tokens-3-5-sonnet-2025-04-14',
        apiKeyHeader: 'sk-ant-api03-x',
      },
      undefined,
    );
    expect(h['anthropic-beta']).toBe('max-tokens-3-5-sonnet-2025-04-14');
  });
});

describe('serializeRequest', () => {
  it('targets /messages and uses the env key when no passthrough', () => {
    const req = createAnthropicAdapter({ env }).serializeRequest({
      model: 'claude-sonnet-4-6',
      stream: false,
      body: { model: 'claude-sonnet-4-6' },
    });
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-api03-envkey');
  });

  it('uses a pooled token when a token pool is provided', () => {
    const pool = new TokenPool();
    pool.registerConfigAccounts(
      [{ apiKey: 'sk-ant-api03-pooled', label: 'a' }],
      0,
    );
    const req = createAnthropicAdapter({
      env,
      tokenPool: pool,
    }).serializeRequest({ model: 'm', stream: false, body: {} });
    expect(req.headers['x-api-key']).toBe('sk-ant-api03-pooled');
  });
});

describe('parseResponse and usage', () => {
  it('captures request-id and the 5m/1h cache split plus aggregate', () => {
    const adapter = createAnthropicAdapter({ env });
    const parsed = adapter.parseResponse({
      status: 200,
      headers: { 'request-id': 'req_ant_1' },
      body: JSON.stringify({
        id: 'msg_1',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 2048,
          cache_creation: {
            ephemeral_5m_input_tokens: 1024,
            ephemeral_1h_input_tokens: 1024,
          },
        },
      }),
    });
    expect(parsed.providerRequestId).toBe('req_ant_1');
    expect(parsed.providerResponseId).toBe('msg_1');
    expect(parsed.stopReason).toBe('end_turn');
    expect(parsed.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 40,
      cacheWriteShortTokens: 1024,
      cacheWriteLongTokens: 1024,
      extra: { cache_creation_input_tokens: 2048 },
    });
  });

  it('attributes an aggregate-only cache_creation to the short bucket', () => {
    const usage = extractAnthropicUsage({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 500,
      },
    });
    expect(usage).toMatchObject({
      cacheWriteShortTokens: 500,
      cacheWriteLongTokens: 0,
    });
  });
});

describe('parseAnthropicSse and classifyError', () => {
  it('parses event+data blocks', () => {
    const events = parseAnthropicSse(
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'message_stop',
    ]);
  });

  it('classifies overloaded_error as overloaded', () => {
    expect(
      createAnthropicAdapter({ env }).classifyError({
        status: 500,
        body: { type: 'error', error: { type: 'overloaded_error' } },
      }),
    ).toBe('provider_overloaded');
  });

  it('healthCheck reflects transport status', async () => {
    const ok: Transport = async () => ({
      status: 200,
      headers: {},
      body: '{}',
    });
    expect(await createAnthropicAdapter({ env }).healthCheck(ok)).toBe(true);
  });
});

describe('TokenPool', () => {
  it('rotates, skips 429-limited tokens, and quarantines after two 401s', () => {
    const pool = new TokenPool();
    pool.registerConfigAccounts(
      [
        { apiKey: 'k1', priority: 1 },
        { apiKey: 'k2', priority: 2 },
      ],
      0,
    );

    // Lowest priority first.
    expect(pool.selectToken(0)?.apiKey).toBe('k1');

    // 429 on k1 -> next selection prefers k2.
    pool.record429('k1', 30, 1000);
    expect(pool.selectToken(1000)?.apiKey).toBe('k2');

    // Two 401s on k2 -> quarantined; k1 still rate-limited at t=2000 -> null.
    pool.recordAuthFailure('k2', 2000);
    pool.recordAuthFailure('k2', 2000);
    expect(pool.selectToken(2000)).toBeNull();

    // After k1's rate-limit window expires it is available again.
    expect(pool.selectToken(60_000)?.apiKey).toBe('k1');
  });

  it('learns the RPM limit and proactively skips a near-cap token', () => {
    const pool = new TokenPool();
    pool.registerConfigAccounts([{ apiKey: 'k1' }], 0);
    pool.recordResponseHeaders(
      'k1',
      { 'anthropic-ratelimit-requests-limit': '10' },
      0,
    );
    // 9 requests reaches 90% of 10 -> token becomes unavailable.
    for (let i = 0; i < 9; i += 1) {
      pool.selectToken(0);
    }
    expect(pool.selectToken(0)).toBeNull();
  });

  it('recordSuccess resets the auth-failure counter', () => {
    const pool = new TokenPool();
    pool.registerConfigAccounts([{ apiKey: 'k1' }], 0);
    pool.recordAuthFailure('k1', 0);
    pool.recordSuccess('k1');
    pool.recordAuthFailure('k1', 0); // only 1 consecutive now -> not quarantined
    expect(pool.selectToken(0)?.apiKey).toBe('k1');
  });
});
