/**
 * Unit tests for exporter health and metrics (epic AIPP-5, subtask 5.5).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  ExporterMetrics,
  exporterHealth,
  formatExporterHealth,
} from '../../../src/integrations/tokemetry/health.js';
import { TokemetryOutbox } from '../../../src/integrations/tokemetry/outbox.js';
import type { CanonicalUsageEvent } from '../../../src/lifecycle/usage-event.js';

const event = (id: string) =>
  ({
    eventId: id,
    finality: 'final',
    sequence: 0,
    inputTokens: 1,
    outputTokens: 1,
  }) as unknown as CanonicalUsageEvent;

describe('ExporterMetrics', () => {
  it('accumulates flush results', () => {
    const m = new ExporterMetrics();
    m.recordEnqueue();
    m.recordFlush({ claimed: 3, exported: 2, retried: 1, dead: 0 }, 1000);
    m.recordFlush(
      { claimed: 1, exported: 0, retried: 0, dead: 1 },
      2000,
      'ingest 400',
    );
    expect(m.snapshot()).toMatchObject({
      enqueued: 1,
      exported: 2,
      dead: 1,
      retried: 1,
      flushes: 2,
      lastFlushAt: 2000,
      lastError: 'ingest 400',
    });
  });
});

describe('exporterHealth', () => {
  it('is healthy with no dead letters and a small backlog', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    outbox.enqueue(event('e1'), 0);
    const health = exporterHealth(outbox);
    expect(health).toMatchObject({ pending: 1, dead: 0, healthy: true });
    outbox.close();
  });

  it('is degraded when there are dead-lettered events', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    const id = outbox.enqueue(event('e1'), 0);
    outbox.markDead([id], 'poison');
    const health = exporterHealth(outbox, { metrics: new ExporterMetrics() });
    expect(health).toMatchObject({ dead: 1, healthy: false });
    expect(formatExporterHealth(health)).toContain('DEGRADED');
    outbox.close();
  });

  it('is degraded when the backlog exceeds the warn threshold', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    outbox.enqueue(event('e1'), 0);
    expect(exporterHealth(outbox, { pendingWarn: 0 }).healthy).toBe(false);
    outbox.close();
  });
});
