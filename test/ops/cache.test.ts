/**
 * Response cache unit tests (epic AIPP-11, subtask 11.4).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  ResponseCache,
  computeCacheKey,
  isDeterministic,
  type CacheConfig,
} from '../../src/ops/cache/index.js';

const T0 = Date.parse('2026-07-26T12:00:00.000Z');

function config(over: Partial<CacheConfig> = {}): CacheConfig {
  return {
    enabled: true,
    maxSizeMb: 100,
    defaultTtlSeconds: 3600,
    onlyWhenDeterministic: true,
    ...over,
  };
}

function cache(cfg: CacheConfig, clock = { t: T0 }) {
  return new ResponseCache(cfg, {
    database: new Database(':memory:'),
    now: () => clock.t,
  });
}

describe('computeCacheKey', () => {
  it('is stable and ignores non-keyed fields (stream, headers)', () => {
    const a = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    };
    const b = {
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      stream: false,
    };
    expect(computeCacheKey(a)).toBe(computeCacheKey(b));
  });

  it('differs when a keyed field differs', () => {
    const a = computeCacheKey({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const b = computeCacheKey({
      model: 'm',
      messages: [{ role: 'user', content: 'bye' }],
    });
    expect(a).not.toBe(b);
  });
});

describe('isDeterministic', () => {
  it('is true for unset/0 temperature, false otherwise', () => {
    expect(isDeterministic({})).toBe(true);
    expect(isDeterministic({ temperature: 0 })).toBe(true);
    expect(isDeterministic({ temperature: 0.7 })).toBe(false);
  });
});

describe('ResponseCache', () => {
  it('bypasses when disabled or non-deterministic', () => {
    expect(cache(config({ enabled: false })).shouldBypass({})).toBe(true);
    expect(cache(config()).shouldBypass({ temperature: 0.9 })).toBe(true);
    expect(cache(config()).shouldBypass({ temperature: 0 })).toBe(false);
  });

  it('stores and replays a body (miss then hit)', () => {
    const c = cache(config());
    const key = 'k1';
    expect(c.get(key)).toBeUndefined(); // miss
    c.set(key, 'model', { answer: 42 });
    expect(c.get(key)).toEqual({ answer: 42 }); // hit
    const stats = c.getStats();
    expect(stats.entries).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it('expires an entry after its TTL', () => {
    const clock = { t: T0 };
    const c = cache(config({ defaultTtlSeconds: 60 }), clock);
    c.set('k', 'm', { v: 1 });
    clock.t = T0 + 61_000;
    expect(c.get('k')).toBeUndefined(); // expired
    expect(c.getStats().entries).toBe(0); // and pruned
  });

  it('evicts the oldest entries past the size budget', () => {
    const clock = { t: T0 };
    // A tiny budget so inserting several entries forces eviction.
    const c = cache(config({ maxSizeMb: 0.00005 }), clock);
    for (let i = 0; i < 5; i++) {
      clock.t = T0 + i;
      c.set(`k${i}`, 'm', { blob: `payload-${i}-${'x'.repeat(50)}` });
    }
    // The oldest key is evicted first and the cache stays under the cap.
    expect(c.get('k0')).toBeUndefined();
    expect(c.getStats().entries).toBeLessThan(5);
    expect(c.getStats().sizeBytes).toBeLessThanOrEqual(0.00005 * 1_000_000);
  });

  it('clears every entry', () => {
    const c = cache(config());
    c.set('a', 'm', { v: 1 });
    c.clear();
    expect(c.getStats().entries).toBe(0);
  });
});
