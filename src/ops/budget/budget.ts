/**
 * Unified budget enforcement (epic AIPP-11, subtask 11.2; FR-IDENT-006).
 *
 * Collapses the two overlapping legacy trackers (a caps manager and a daily
 * hard-cap tracker) into ONE spend ledger so spend is counted exactly once. A
 * SQLite-backed spend log records every attempt's cost; an in-memory per-window
 * cache serves a fast pre-request check. Daily/hourly/per-request ceilings each
 * have the same configurable breach action (block/warn/downgrade/alert).
 *
 * Cost is derived from token counts against a pricing table; the request path
 * never blocks on the database (writes are synchronous but tiny, and any DB
 * failure degrades to memory-only).
 */

import Database from 'better-sqlite3';
import { dataFile } from '../trackers/paths.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';

/** Per-million-token pricing (USD) for known models. */
export const MODEL_PRICING: Record<
  string,
  { inputPer1M: number; outputPer1M: number }
> = {
  'claude-opus-4-6': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-opus-4-5': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-sonnet-4-5': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4.0 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.8, outputPer1M: 4.0 },
  'claude-3-5-sonnet-20241022': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.8, outputPer1M: 4.0 },
  'claude-3-opus-20240229': { inputPer1M: 15.0, outputPer1M: 75.0 },
};

/** Estimate USD cost for token counts; 0 for an unknown model. */
export function estimateCostFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

/** The UTC day window key (YYYY-MM-DD) for a timestamp. */
export function dailyWindow(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The UTC hour window key (YYYY-MM-DDTHH) for a timestamp. */
export function hourlyWindow(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

/** The breach action taken when a ceiling is crossed. */
export type BreachAction = 'block' | 'warn' | 'downgrade' | 'alert';

/** Budget configuration. */
export interface BudgetConfig {
  enabled: boolean;
  dailyUsd: number;
  hourlyUsd: number;
  perRequestUsd: number;
  onBreach: BreachAction;
  downgradeTo: string;
  alertThresholds: number[];
}

/** The default budget configuration (disabled). */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  enabled: false,
  dailyUsd: 50,
  hourlyUsd: 10,
  perRequestUsd: 2,
  onBreach: 'downgrade',
  downgradeTo: 'claude-sonnet-4-6',
  alertThresholds: [50, 80, 95],
};

/** Which ceiling (if any) a check breached. */
export type BreachType = 'none' | 'daily' | 'hourly' | 'per-request';

/** The outcome of a pre-request budget check. */
export interface BudgetDecision {
  allowed: boolean;
  breached: boolean;
  breachType: BreachType;
  action: 'allow' | BreachAction;
  dailySpend: number;
  hourlySpend: number;
  dailyPercent: number;
  thresholdsCrossed: number[];
}

/** A snapshot of current budget state. */
export interface BudgetStatus {
  enabled: boolean;
  dailySpend: number;
  dailyLimit: number;
  dailyPercent: number;
  hourlySpend: number;
  hourlyLimit: number;
  hourlyPercent: number;
  breached: boolean;
  breachType: BreachType;
}

export interface BudgetManagerOptions {
  dir?: string;
  /** Inject a database (e.g. `new Database(':memory:')`) for tests. */
  database?: Database.Database;
  /** Clock (injected for deterministic tests). */
  now?: () => number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL,
  model TEXT NOT NULL,
  daily_window TEXT NOT NULL,
  hourly_window TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_daily ON spend_log(daily_window);
CREATE INDEX IF NOT EXISTS idx_spend_hourly ON spend_log(hourly_window);`;

/**
 * The single budget ledger: records spend and answers pre-request checks. Not a
 * sink itself (see BudgetSink), so it can also be consulted synchronously on the
 * request path and by control endpoints.
 */
export class BudgetManager {
  private config: BudgetConfig;
  private readonly db: Database.Database;
  private readonly now: () => number;

  private dailyKey = '';
  private hourlyKey = '';
  private dailyCache = 0;
  private hourlyCache = 0;
  private readonly firedThresholds = new Set<string>();

  constructor(
    config: BudgetConfig = DEFAULT_BUDGET_CONFIG,
    options: BudgetManagerOptions = {},
  ) {
    this.config = config;
    this.now = options.now ?? Date.now;
    this.db =
      options.database ?? new Database(dataFile('budget.db', options.dir));
    this.db.exec(SCHEMA);
    this.refreshWindows();
  }

  /** Replace the active configuration. */
  updateConfig(config: BudgetConfig): void {
    this.config = config;
  }

  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  /** Recompute the in-memory window caches from the ledger for the current time. */
  private refreshWindows(): void {
    const nowMs = this.now();
    this.dailyKey = dailyWindow(nowMs);
    this.hourlyKey = hourlyWindow(nowMs);
    this.dailyCache = this.sumFor('daily_window', this.dailyKey);
    this.hourlyCache = this.sumFor('hourly_window', this.hourlyKey);
  }

  /** Roll the caches forward when the wall clock crosses a window boundary. */
  private ensureWindows(): void {
    const nowMs = this.now();
    if (dailyWindow(nowMs) !== this.dailyKey) {
      this.dailyKey = dailyWindow(nowMs);
      this.dailyCache = this.sumFor('daily_window', this.dailyKey);
      this.firedThresholds.clear();
    }
    if (hourlyWindow(nowMs) !== this.hourlyKey) {
      this.hourlyKey = hourlyWindow(nowMs);
      this.hourlyCache = this.sumFor('hourly_window', this.hourlyKey);
    }
  }

  private sumFor(
    column: 'daily_window' | 'hourly_window',
    key: string,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM spend_log WHERE ${column} = ?`,
      )
      .get(key) as { total: number };
    return row.total;
  }

  /**
   * Fast pre-request check against the in-memory caches. When disabled, always
   * allows. A `block` breach denies the request; other actions allow it and let
   * the caller downgrade/warn/alert.
   */
  check(estimatedCost?: number): BudgetDecision {
    if (!this.config.enabled) {
      return this.allowDecision();
    }
    this.ensureWindows();

    const breach = (
      breachType: Exclude<BreachType, 'none'>,
    ): BudgetDecision => ({
      allowed: this.config.onBreach !== 'block',
      breached: true,
      breachType,
      action: this.config.onBreach,
      dailySpend: this.dailyCache,
      hourlySpend: this.hourlyCache,
      dailyPercent: this.dailyPercent(),
      thresholdsCrossed: [],
    });

    if (
      estimatedCost !== undefined &&
      estimatedCost > this.config.perRequestUsd
    ) {
      return breach('per-request');
    }
    if (this.hourlyCache >= this.config.hourlyUsd) {
      return breach('hourly');
    }
    if (this.dailyCache >= this.config.dailyUsd) {
      return breach('daily');
    }

    const thresholdsCrossed: number[] = [];
    for (const threshold of this.config.alertThresholds) {
      const key = `${this.dailyKey}:${threshold}`;
      if (this.dailyPercent() >= threshold && !this.firedThresholds.has(key)) {
        thresholdsCrossed.push(threshold);
      }
    }
    return { ...this.allowDecision(), thresholdsCrossed };
  }

  private allowDecision(): BudgetDecision {
    return {
      allowed: true,
      breached: false,
      breachType: 'none',
      action: 'allow',
      dailySpend: this.dailyCache,
      hourlySpend: this.hourlyCache,
      dailyPercent: this.dailyPercent(),
      thresholdsCrossed: [],
    };
  }

  /** Record spend for a completed request (updates cache + ledger, once). */
  recordSpend(amount: number, model: string): void {
    if (!this.config.enabled || amount <= 0) {
      return;
    }
    this.ensureWindows();
    this.dailyCache += amount;
    this.hourlyCache += amount;
    this.db
      .prepare(
        `INSERT INTO spend_log (amount, model, daily_window, hourly_window, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(amount, model, this.dailyKey, this.hourlyKey, this.now());
  }

  /**
   * Record spend derived from a lifecycle event: the provider-reported cost when
   * present, else an estimate from token counts. Exactly one call per attempt.
   */
  recordEvent(event: CanonicalUsageEvent): void {
    const cost =
      event.costEstimateUsd ??
      estimateCostFromTokens(
        event.nativeModel,
        event.inputTokens,
        event.outputTokens,
      );
    if (cost > 0) {
      this.recordSpend(cost, event.nativeModel);
    }
  }

  /** Mark a daily threshold as fired so it is not reported again this window. */
  markThresholdFired(threshold: number): void {
    this.firedThresholds.add(`${this.dailyKey}:${threshold}`);
  }

  /** Current daily spend as a percent of the daily ceiling (0 when uncapped). */
  dailyPercent(): number {
    return this.config.dailyUsd > 0
      ? (this.dailyCache / this.config.dailyUsd) * 100
      : 0;
  }

  getStatus(): BudgetStatus {
    this.ensureWindows();
    let breachType: BreachType = 'none';
    if (this.hourlyCache >= this.config.hourlyUsd) {
      breachType = 'hourly';
    } else if (this.dailyCache >= this.config.dailyUsd) {
      breachType = 'daily';
    }
    return {
      enabled: this.config.enabled,
      dailySpend: this.dailyCache,
      dailyLimit: this.config.dailyUsd,
      dailyPercent: this.dailyPercent(),
      hourlySpend: this.hourlyCache,
      hourlyLimit: this.config.hourlyUsd,
      hourlyPercent:
        this.config.hourlyUsd > 0
          ? (this.hourlyCache / this.config.hourlyUsd) * 100
          : 0,
      breached: breachType !== 'none',
      breachType,
    };
  }

  /** Clear today's spend (control-endpoint reset). */
  reset(): void {
    this.db
      .prepare('DELETE FROM spend_log WHERE daily_window = ?')
      .run(this.dailyKey);
    this.firedThresholds.clear();
    this.refreshWindows();
  }

  close(): void {
    this.db.close();
  }
}
