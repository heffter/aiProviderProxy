/**
 * Anomaly detection (epic AIPP-11, subtask 11.3; FR-IDENT-006).
 *
 * A sliding-window detector for runaway agent loops and cost spikes, ported from
 * the legacy proxy. In-memory only (a circular buffer of the last 100 requests
 * plus minute buckets for a baseline); disabled by default. The clock is
 * injectable so detection is deterministic under test.
 *
 * Detection types: token explosion (single request over a cost threshold),
 * velocity spike (request rate far above baseline), repetition (same
 * model+token pattern repeated, a likely loop), and cost acceleration (spend
 * rate doubling).
 */

/** Anomaly detector configuration. */
export interface AnomalyConfig {
  enabled: boolean;
  /** Requests in the window before a velocity spike is considered. */
  velocityThreshold: number;
  /** Single-request cost (USD) that flags a token explosion. */
  tokenExplosionUsd: number;
  /** Same model+token pattern count in the window before a repetition flag. */
  repetitionThreshold: number;
  /** Analysis window in ms. */
  windowMs: number;
}

/** The default anomaly configuration (disabled). */
export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  enabled: false,
  velocityThreshold: 50,
  tokenExplosionUsd: 5.0,
  repetitionThreshold: 20,
  windowMs: 300_000,
};

/** A kind of anomaly. */
export type AnomalyType =
  | 'velocity_spike'
  | 'cost_acceleration'
  | 'repetition'
  | 'token_explosion'
  | 'stuck_agent';

/** One detected anomaly. */
export interface AnomalyDetail {
  type: AnomalyType;
  message: string;
  severity: 'warning' | 'critical';
  data: Record<string, number | string>;
}

/** The result of a record-and-analyze pass. */
export interface AnomalyResult {
  detected: boolean;
  anomalies: AnomalyDetail[];
}

/** A completed request to analyze. */
export interface RequestSample {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

interface RequestEntry extends RequestSample {
  timestamp: number;
}

export interface AnomalyDetectorOptions {
  now?: () => number;
}

export class AnomalyDetector {
  private config: AnomalyConfig;
  private readonly now: () => number;
  private buffer: RequestEntry[] = [];
  private readonly minuteBuckets = new Map<number, number>();
  private readonly maxBufferSize = 100;

  constructor(
    config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
    options: AnomalyDetectorOptions = {},
  ) {
    this.config = config;
    this.now = options.now ?? Date.now;
  }

  updateConfig(config: AnomalyConfig): void {
    this.config = config;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
    this.minuteBuckets.clear();
  }

  /** Record a completed request and return any anomalies it triggers. */
  recordAndAnalyze(entry: RequestSample): AnomalyResult {
    if (!this.config.enabled) {
      return { detected: false, anomalies: [] };
    }
    const record: RequestEntry = { ...entry, timestamp: this.now() };

    this.buffer.push(record);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    const minuteKey = Math.floor(record.timestamp / 60_000);
    this.minuteBuckets.set(
      minuteKey,
      (this.minuteBuckets.get(minuteKey) ?? 0) + 1,
    );
    const cutoff = minuteKey - 60;
    for (const [key] of this.minuteBuckets) {
      if (key < cutoff) {
        this.minuteBuckets.delete(key);
      }
    }

    return this.analyze(record);
  }

  private analyze(current: RequestEntry): AnomalyResult {
    const anomalies: AnomalyDetail[] = [];
    const windowStart = current.timestamp - this.config.windowMs;
    const recent = this.buffer.filter((r) => r.timestamp >= windowStart);
    const windowSecs = this.config.windowMs / 1000;

    // 1. Token explosion: a single expensive request.
    if (current.costUsd > this.config.tokenExplosionUsd) {
      anomalies.push({
        type: 'token_explosion',
        message: `Single request cost $${current.costUsd.toFixed(4)} exceeds threshold $${this.config.tokenExplosionUsd}`,
        severity: 'critical',
        data: {
          costUsd: current.costUsd,
          threshold: this.config.tokenExplosionUsd,
          model: current.model,
        },
      });
    }

    // 2. Velocity spike: request rate far above baseline or over the threshold.
    if (recent.length >= this.config.velocityThreshold) {
      const expectedIn5Min = this.getBaselineRpm() * 5;
      const currentRate = recent.length;
      if (expectedIn5Min > 0 && currentRate > expectedIn5Min * 10) {
        anomalies.push({
          type: 'velocity_spike',
          message: `${currentRate} requests in ${windowSecs}s (baseline: ~${Math.round(expectedIn5Min)}/5min)`,
          severity: 'warning',
          data: {
            currentRate,
            baseline: expectedIn5Min,
            windowMs: this.config.windowMs,
          },
        });
      } else {
        anomalies.push({
          type: 'velocity_spike',
          message: `${currentRate} requests in ${windowSecs}s exceeds threshold ${this.config.velocityThreshold}`,
          severity: 'warning',
          data: {
            currentRate,
            threshold: this.config.velocityThreshold,
            windowMs: this.config.windowMs,
          },
        });
      }
    }

    // 3. Repetition: the same model+token bucket repeated (a likely loop).
    if (recent.length >= this.config.repetitionThreshold) {
      const patternCounts = new Map<string, number>();
      for (const r of recent) {
        const tokenBucket = Math.round((r.tokensIn + r.tokensOut) / 100) * 100;
        const key = `${r.model}:${tokenBucket}`;
        patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1);
      }
      for (const [pattern, count] of patternCounts) {
        if (count >= this.config.repetitionThreshold) {
          anomalies.push({
            type: 'repetition',
            message: `Pattern "${pattern}" repeated ${count} times in ${windowSecs}s (possible agent loop)`,
            severity: 'critical',
            data: {
              pattern,
              count,
              threshold: this.config.repetitionThreshold,
            },
          });
          break;
        }
      }
    }

    // 4. Cost acceleration: spend rate doubling across the window halves.
    if (recent.length >= 10) {
      const mid = Math.floor(recent.length / 2);
      const first = recent.slice(0, mid);
      const second = recent.slice(mid);
      const firstCost = first.reduce((s, r) => s + r.costUsd, 0);
      const secondCost = second.reduce((s, r) => s + r.costUsd, 0);
      const firstDuration =
        first[first.length - 1].timestamp - first[0].timestamp || 1;
      const secondDuration =
        second[second.length - 1].timestamp - second[0].timestamp || 1;
      const firstRate = firstCost / firstDuration;
      const secondRate = secondCost / secondDuration;
      if (firstRate > 0 && secondRate > firstRate * 2 && secondCost > 1) {
        anomalies.push({
          type: 'cost_acceleration',
          message: `Cost rate doubled: $${(firstRate * 60000).toFixed(4)}/min -> $${(secondRate * 60000).toFixed(4)}/min`,
          severity: 'warning',
          data: {
            firstRatePerMin: firstRate * 60000,
            secondRatePerMin: secondRate * 60000,
            ratio: secondRate / firstRate,
          },
        });
      }
    }

    return { detected: anomalies.length > 0, anomalies };
  }

  private getBaselineRpm(): number {
    if (this.minuteBuckets.size <= 1) {
      return 0;
    }
    let total = 0;
    for (const [, count] of this.minuteBuckets) {
      total += count;
    }
    return total / this.minuteBuckets.size;
  }
}
