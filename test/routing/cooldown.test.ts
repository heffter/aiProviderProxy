/**
 * Cooldown circuit-breaker unit tests (epic AIPP-10, subtask 10.4; FR-ROUTE-011).
 */

import { describe, it, expect } from 'vitest';
import {
  CooldownManager,
  type CooldownConfig,
} from '../../src/routing/cooldown.js';

const config: CooldownConfig = {
  enabled: true,
  allowedFails: 3,
  windowSeconds: 60,
  cooldownSeconds: 120,
};

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('CooldownManager', () => {
  it('trips a cooldown at the failure threshold and skips the provider', () => {
    const c = clock();
    const cd = new CooldownManager(config, { now: c.now });
    expect(cd.isAvailable('anthropic')).toBe(true);
    cd.recordFailure('anthropic');
    cd.recordFailure('anthropic');
    expect(cd.isAvailable('anthropic')).toBe(true); // 2 < 3
    cd.recordFailure('anthropic');
    expect(cd.isAvailable('anthropic')).toBe(false); // tripped
  });

  it('self-heals after the cooldown interval elapses', () => {
    const c = clock();
    const cd = new CooldownManager(config, { now: c.now });
    for (let i = 0; i < 3; i++) cd.recordFailure('openai');
    expect(cd.isAvailable('openai')).toBe(false);
    c.advance(120_000 + 1);
    expect(cd.isAvailable('openai')).toBe(true); // cooled off
  });

  it('prunes failures outside the sliding window', () => {
    const c = clock();
    const cd = new CooldownManager(config, { now: c.now });
    cd.recordFailure('google');
    cd.recordFailure('google');
    c.advance(61_000); // both fall outside the 60s window
    cd.recordFailure('google');
    expect(cd.isAvailable('google')).toBe(true); // only 1 fresh failure
  });

  it('a success clears accumulated failures', () => {
    const c = clock();
    const cd = new CooldownManager(config, { now: c.now });
    cd.recordFailure('zai');
    cd.recordFailure('zai');
    cd.recordSuccess('zai');
    cd.recordFailure('zai');
    cd.recordFailure('zai');
    expect(cd.isAvailable('zai')).toBe(true); // reset, so 2 < 3
  });

  it('is a no-op when disabled', () => {
    const cd = new CooldownManager({ ...config, enabled: false });
    for (let i = 0; i < 10; i++) cd.recordFailure('x');
    expect(cd.isAvailable('x')).toBe(true);
  });
});
