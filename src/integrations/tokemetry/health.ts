/**
 * Exporter health and metrics (epic AIPP-5, subtask 5.5; NFR-REL, FR-TOK).
 *
 * Runtime counters for the exporter plus a health report combining live outbox
 * state (pending / exported / dead) with those counters, for `aipp tokemetry
 * status` and monitoring.
 */

import type { FlushResult } from './batcher.js';
import type { TokemetryOutbox } from './outbox.js';

/** Cumulative exporter counters. */
export class ExporterMetrics {
  enqueued = 0;
  exported = 0;
  dead = 0;
  retried = 0;
  flushes = 0;
  lastFlushAt?: number;
  lastError?: string;

  recordEnqueue(): void {
    this.enqueued += 1;
  }

  recordFlush(result: FlushResult, now: number, error?: string): void {
    this.flushes += 1;
    this.exported += result.exported;
    this.dead += result.dead;
    this.retried += result.retried;
    this.lastFlushAt = now;
    if (error) {
      this.lastError = error;
    }
  }

  snapshot(): {
    enqueued: number;
    exported: number;
    dead: number;
    retried: number;
    flushes: number;
    lastFlushAt?: number;
    lastError?: string;
  } {
    return {
      enqueued: this.enqueued,
      exported: this.exported,
      dead: this.dead,
      retried: this.retried,
      flushes: this.flushes,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
    };
  }
}

/** A point-in-time health report for the exporter. */
export interface ExporterHealth {
  pending: number;
  exported: number;
  dead: number;
  healthy: boolean;
  metrics?: ReturnType<ExporterMetrics['snapshot']>;
}

/**
 * Combine live outbox counts with optional runtime metrics. `healthy` is false
 * when there are dead-lettered events or a backlog beyond `pendingWarn`.
 */
export function exporterHealth(
  outbox: TokemetryOutbox,
  options: { metrics?: ExporterMetrics; pendingWarn?: number } = {},
): ExporterHealth {
  const counts = outbox.counts();
  const pendingWarn = options.pendingWarn ?? 10_000;
  return {
    pending: counts.pending,
    exported: counts.exported,
    dead: counts.dead,
    healthy: counts.dead === 0 && counts.pending <= pendingWarn,
    metrics: options.metrics?.snapshot(),
  };
}

/** Render an exporter health report for CLI output. */
export function formatExporterHealth(health: ExporterHealth): string {
  const lines = [
    `tokemetry exporter: ${health.healthy ? 'healthy' : 'DEGRADED'}`,
    `  pending:  ${health.pending}`,
    `  exported: ${health.exported}`,
    `  dead:     ${health.dead}`,
  ];
  if (health.metrics) {
    lines.push(
      `  flushes:  ${health.metrics.flushes}`,
      `  retried:  ${health.metrics.retried}`,
    );
    if (health.metrics.lastError) {
      lines.push(`  last error: ${health.metrics.lastError}`);
    }
  }
  return lines.join('\n');
}
