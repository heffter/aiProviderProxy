/**
 * Anomaly detector unit tests (epic AIPP-11, subtask 11.3).
 */

import { describe, it, expect } from 'vitest';
import {
  AnomalyDetector,
  type AnomalyConfig,
} from '../../src/ops/anomaly/index.js';

const T0 = Date.parse('2026-07-26T12:00:00.000Z');

function config(over: Partial<AnomalyConfig> = {}): AnomalyConfig {
  return {
    enabled: true,
    velocityThreshold: 50,
    tokenExplosionUsd: 5,
    repetitionThreshold: 20,
    windowMs: 300_000,
    ...over,
  };
}

function detector(cfg: AnomalyConfig, clock: { t: number }) {
  return new AnomalyDetector(cfg, { now: () => clock.t });
}

const sample = {
  model: 'claude-opus-4-6',
  tokensIn: 10,
  tokensOut: 10,
  costUsd: 0,
};

describe('AnomalyDetector', () => {
  it('detects nothing when disabled', () => {
    const clock = { t: T0 };
    const d = detector(config({ enabled: false }), clock);
    expect(d.recordAndAnalyze({ ...sample, costUsd: 100 }).detected).toBe(
      false,
    );
  });

  it('flags a token explosion for an expensive single request', () => {
    const clock = { t: T0 };
    const d = detector(config({ velocityThreshold: 100 }), clock);
    const result = d.recordAndAnalyze({ ...sample, costUsd: 10 });
    expect(result.anomalies.map((a) => a.type)).toContain('token_explosion');
  });

  it('flags a velocity spike above the threshold', () => {
    const clock = { t: T0 };
    const d = detector(config({ velocityThreshold: 3 }), clock);
    let result = { detected: false, anomalies: [] as { type: string }[] };
    for (let i = 0; i < 3; i++) {
      result = d.recordAndAnalyze(sample);
    }
    expect(result.anomalies.map((a) => a.type)).toContain('velocity_spike');
  });

  it('flags a repetition loop', () => {
    const clock = { t: T0 };
    const d = detector(
      config({ repetitionThreshold: 3, velocityThreshold: 100 }),
      clock,
    );
    let result = { anomalies: [] as { type: string }[] };
    for (let i = 0; i < 3; i++) {
      result = d.recordAndAnalyze(sample); // identical model + token bucket
    }
    expect(result.anomalies.map((a) => a.type)).toContain('repetition');
  });

  it('flags cost acceleration when the spend rate doubles', () => {
    const clock = { t: T0 };
    const d = detector(
      config({
        velocityThreshold: 100,
        repetitionThreshold: 100,
        tokenExplosionUsd: 100,
      }),
      clock,
    );
    let result = { anomalies: [] as { type: string }[] };
    for (let i = 0; i < 10; i++) {
      clock.t = T0 + i * 1000;
      result = d.recordAndAnalyze({
        ...sample,
        costUsd: i < 5 ? 0.01 : 1, // cheap first half, expensive second half
      });
    }
    expect(result.anomalies.map((a) => a.type)).toContain('cost_acceleration');
  });

  it('bounds the buffer and can be cleared', () => {
    const clock = { t: T0 };
    const d = detector(config({ velocityThreshold: 1000 }), clock);
    for (let i = 0; i < 150; i++) d.recordAndAnalyze(sample);
    expect(d.getBufferSize()).toBe(100);
    d.clear();
    expect(d.getBufferSize()).toBe(0);
  });
});
