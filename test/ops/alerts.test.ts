/**
 * Alert manager + anomaly-alert sink tests (epic AIPP-11, subtask 11.3).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  AlertManager,
  AnomalyAlertSink,
  type AlertsConfig,
} from '../../src/ops/alerts/index.js';
import { AnomalyDetector } from '../../src/ops/anomaly/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';

const T0 = Date.parse('2026-07-26T12:00:00.000Z');

function config(over: Partial<AlertsConfig> = {}): AlertsConfig {
  return { enabled: true, cooldownMs: 300_000, maxHistory: 500, ...over };
}

function manager(
  cfg: AlertsConfig,
  clock = { t: T0 },
  deliver?: (u: string, p: unknown) => Promise<void>,
) {
  return new AlertManager(cfg, {
    database: new Database(':memory:'),
    now: () => clock.t,
    deliver,
  });
}

describe('AlertManager', () => {
  it('does nothing when disabled', () => {
    const m = manager(config({ enabled: false }));
    expect(m.fireThreshold(80, 82, 8, 10)).toBeNull();
    expect(m.getRecent()).toEqual([]);
  });

  it('records threshold, anomaly, and breach alerts', () => {
    const m = manager(config());
    m.fireThreshold(95, 96, 9.6, 10);
    m.fireBreach('daily', 11, 10);
    m.fireAnomaly({
      type: 'token_explosion',
      message: 'boom',
      severity: 'critical',
      data: {},
    });
    expect(m.getCounts()).toEqual({ threshold: 1, anomaly: 1, breach: 1 });
    expect(m.getRecent()[0].type).toBe('anomaly'); // newest first
  });

  it('deduplicates a repeat within the cooldown, then fires after it', () => {
    const clock = { t: T0 };
    const m = manager(config({ cooldownMs: 1000 }), clock);
    expect(m.fireThreshold(80, 82, 8, 10)).not.toBeNull();
    expect(m.fireThreshold(80, 83, 8.3, 10)).toBeNull(); // within cooldown
    clock.t = T0 + 1001;
    expect(m.fireThreshold(80, 84, 8.4, 10)).not.toBeNull();
  });

  it('delivers to a configured webhook (opt-in egress)', async () => {
    const calls: Array<{ url: string; payload: unknown }> = [];
    const m = manager(
      config({ webhookUrl: 'https://hook.example/alerts' }),
      { t: T0 },
      async (url, payload) => {
        calls.push({ url, payload });
      },
    );
    m.fireBreach('daily', 11, 10);
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hook.example/alerts');
    expect((calls[0].payload as { source: string }).source).toBe(
      'aiproviderproxy',
    );
  });

  it('does not deliver when no webhook is configured', async () => {
    let delivered = false;
    const m = manager(config(), { t: T0 }, async () => {
      delivered = true;
    });
    m.fireBreach('daily', 11, 10);
    await new Promise((r) => setImmediate(r));
    expect(delivered).toBe(false);
  });
});

describe('AnomalyAlertSink', () => {
  it('fires an alert for an anomaly surfaced by a completed request', () => {
    const clock = { t: T0 };
    const detector = new AnomalyDetector(
      {
        enabled: true,
        velocityThreshold: 100,
        tokenExplosionUsd: 1,
        repetitionThreshold: 100,
        windowMs: 300_000,
      },
      { now: () => clock.t },
    );
    const alerts = manager(config());
    const sink = new AnomalyAlertSink(detector, alerts);
    sink.onLogicalRequestFinal({
      nativeModel: 'claude-opus-4-6',
      inputTokens: 1,
      outputTokens: 1,
      costEstimateUsd: 9.99, // over the $1 token-explosion threshold
    } as unknown as CanonicalUsageEvent);
    expect(alerts.getCounts().anomaly).toBe(1);
  });
});
