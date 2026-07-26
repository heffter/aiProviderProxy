/**
 * Unit tests for the /v1/models and /v1/estimate endpoints (AIPP-8, 8.5).
 */

import { describe, it, expect } from 'vitest';
import {
  listModels,
  estimateChat,
  pricingFor,
  countMessagesTokens,
  countTextTokens,
  EstimateRateLimiter,
} from '../../src/gateway/openai-endpoints.js';

describe('listModels', () => {
  it('lists alias and native ids tagged with the owning provider', () => {
    const list = listModels();
    expect(list.object).toBe('list');
    const byId = new Map(list.data.map((m) => [m.id, m]));
    // A well-known alias and a native id both appear.
    expect(byId.get('gpt-4o')).toMatchObject({
      object: 'model',
      owned_by: 'openai',
    });
    expect(byId.get('sonnet')?.owned_by).toBe('anthropic');
    // Ids are unique and sorted.
    const ids = list.data.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
  });
});

describe('token counting and pricing', () => {
  it('counts tokens with the 4-chars heuristic plus per-message overhead', () => {
    expect(countTextTokens('')).toBe(0);
    expect(countTextTokens('abcd')).toBe(1);
    expect(countMessagesTokens([{ role: 'user', content: 'abcdefgh' }])).toBe(
      6,
    ); // 4 overhead + 2 tokens
  });

  it('resolves model-specific pricing with provider fallback', () => {
    expect(pricingFor('claude-opus-4-6', 'anthropic').outputPerM).toBe(75);
    expect(pricingFor('gpt-4o-mini', 'openai').inputPerM).toBe(0.15);
    expect(pricingFor('some-unknown', 'ollama')).toEqual({
      inputPerM: 0,
      outputPerM: 0,
    });
  });
});

describe('estimateChat', () => {
  it('estimates cost from input tokens and a default output multiplier', () => {
    const est = estimateChat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'a'.repeat(400) }],
    });
    expect(est).not.toBeNull();
    if (est) {
      expect(est.provider).toBe('openai');
      expect(est.input_tokens).toBe(104); // 4 overhead + 100
      expect(est.estimated_output_tokens).toBe(52); // 0.5x default
      expect(est.currency).toBe('USD');
      expect(est.estimated_cost_usd).toBeGreaterThan(0);
    }
  });

  it('honors an explicit max_tokens for the output estimate', () => {
    const est = estimateChat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1000,
    });
    expect(est?.estimated_output_tokens).toBe(1000);
  });

  it('returns null for an unknown model', () => {
    expect(
      estimateChat({ model: 'no-such-model-xyz', messages: [] }),
    ).toBeNull();
  });
});

describe('EstimateRateLimiter', () => {
  it('allows up to the limit then blocks within the window', () => {
    const t = 0;
    const limiter = new EstimateRateLimiter({
      limit: 3,
      windowMs: 1000,
      now: () => t,
    });
    expect(limiter.check('c').allowed).toBe(true);
    expect(limiter.check('c').allowed).toBe(true);
    expect(limiter.check('c').allowed).toBe(true);
    const blocked = limiter.check('c');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets after the window and isolates clients', () => {
    let t = 0;
    const limiter = new EstimateRateLimiter({
      limit: 1,
      windowMs: 1000,
      now: () => t,
    });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true); // different client
    t = 1000; // window elapsed
    expect(limiter.check('a').allowed).toBe(true);
  });
});
