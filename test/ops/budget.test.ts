/**
 * Unified budget manager unit tests (epic AIPP-11, subtask 11.2).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  BudgetManager,
  estimateCostFromTokens,
  dailyWindow,
  hourlyWindow,
  type BudgetConfig,
} from '../../src/ops/budget/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-07-26T12:00:00.000Z');

function config(over: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    enabled: true,
    dailyUsd: 10,
    hourlyUsd: 5,
    perRequestUsd: 2,
    onBreach: 'block',
    downgradeTo: 'claude-sonnet-4-6',
    alertThresholds: [50, 80, 95],
    ...over,
  };
}

function manager(cfg: BudgetConfig, start = { t: T0 }) {
  return new BudgetManager(cfg, {
    database: new Database(':memory:'),
    now: () => start.t,
  });
}

describe('estimateCostFromTokens', () => {
  it('prices a known model and zeroes an unknown one', () => {
    // sonnet: $3/1M in, $15/1M out. 1M in + 1M out = 18.
    expect(
      estimateCostFromTokens('claude-sonnet-4-6', 1_000_000, 1_000_000),
    ).toBe(18);
    expect(estimateCostFromTokens('unknown-model', 1000, 1000)).toBe(0);
  });
});

describe('window keys', () => {
  it('are UTC day and hour truncations', () => {
    expect(dailyWindow(T0)).toBe('2026-07-26');
    expect(hourlyWindow(T0)).toBe('2026-07-26T12');
  });
});

describe('BudgetManager checks', () => {
  it('allows everything when disabled', () => {
    const m = manager(config({ enabled: false }));
    m.recordSpend(1000, 'x');
    expect(m.check().allowed).toBe(true);
  });

  it('blocks a per-request estimate over the cap', () => {
    const m = manager(config());
    const d = m.check(5); // perRequestUsd = 2
    expect(d).toMatchObject({
      breached: true,
      breachType: 'per-request',
      allowed: false,
    });
  });

  it('breaches the daily ceiling and blocks under a block action', () => {
    const m = manager(config({ hourlyUsd: 100 }));
    m.recordSpend(10, 'claude-opus-4-6'); // == dailyUsd
    const d = m.check();
    expect(d).toMatchObject({
      breached: true,
      breachType: 'daily',
      allowed: false,
    });
  });

  it('breaches the hourly ceiling before the daily', () => {
    const m = manager(config({ dailyUsd: 100 }));
    m.recordSpend(5, 'x'); // == hourlyUsd
    expect(m.check().breachType).toBe('hourly');
  });

  it('allows a breach under warn/downgrade/alert but reports the action', () => {
    for (const onBreach of ['warn', 'downgrade', 'alert'] as const) {
      const m = manager(config({ onBreach, hourlyUsd: 100 }));
      m.recordSpend(10, 'x');
      const d = m.check();
      expect(d.allowed).toBe(true);
      expect(d.action).toBe(onBreach);
      expect(d.breached).toBe(true);
    }
  });

  it('reports crossed alert thresholds below the ceiling', () => {
    const m = manager(config({ onBreach: 'warn', hourlyUsd: 100 }));
    m.recordSpend(8, 'x'); // 80% of daily 10, under the hourly ceiling
    expect(m.check().thresholdsCrossed).toContain(80);
    expect(m.check().thresholdsCrossed).toContain(50);
  });
});

describe('window rollover', () => {
  it('resets the daily cache when the clock crosses midnight', () => {
    const clock = { t: T0 };
    const m = manager(config(), clock);
    m.recordSpend(10, 'x');
    expect(m.check().breached).toBe(true);
    clock.t = T0 + DAY; // next day
    expect(m.getStatus().dailySpend).toBe(0);
    expect(m.check().breached).toBe(false);
  });
});

describe('unification: spend counted once', () => {
  it('records exactly one entry per lifecycle event', () => {
    const m = manager(config({ onBreach: 'warn' }));
    const event = {
      nativeModel: 'claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
      costEstimateUsd: undefined,
    } as unknown as CanonicalUsageEvent;
    m.recordEvent(event); // $3
    m.recordEvent(event); // $3
    expect(m.getStatus().dailySpend).toBeCloseTo(6, 5);
  });

  it('prefers a provider-reported cost when present', () => {
    const m = manager(config({ onBreach: 'warn' }));
    m.recordEvent({
      nativeModel: 'claude-opus-4-6',
      inputTokens: 10,
      outputTokens: 10,
      costEstimateUsd: 1.5,
    } as unknown as CanonicalUsageEvent);
    expect(m.getStatus().dailySpend).toBe(1.5);
  });
});

describe('threshold dedup and config', () => {
  it('stops reporting a threshold once marked fired', () => {
    const m = manager(config({ onBreach: 'warn', hourlyUsd: 100 }));
    m.recordSpend(8, 'x');
    expect(m.check().thresholdsCrossed).toContain(80);
    m.markThresholdFired(80);
    expect(m.check().thresholdsCrossed).not.toContain(80);
  });

  it('round-trips config and honours a runtime update', () => {
    const m = manager(config({ enabled: false }));
    expect(m.getConfig().enabled).toBe(false);
    m.updateConfig(config({ enabled: true, dailyUsd: 4, hourlyUsd: 100 }));
    m.recordSpend(4, 'x');
    expect(m.check().breached).toBe(true);
    m.close();
  });
});

describe('status and reset', () => {
  it('reports percent and clears on reset', () => {
    const m = manager(config({ onBreach: 'warn' }));
    m.recordSpend(5, 'x');
    expect(m.getStatus().dailyPercent).toBe(50);
    expect(m.dailyPercent()).toBe(50);
    m.reset();
    expect(m.getStatus().dailySpend).toBe(0);
  });
});
