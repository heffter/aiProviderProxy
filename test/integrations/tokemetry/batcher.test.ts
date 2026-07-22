/**
 * Unit tests for the Tokemetry exporter batcher (epic AIPP-5, subtask 5.3).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TokemetryOutbox } from '../../../src/integrations/tokemetry/outbox.js';
import { TokemetryBatcher } from '../../../src/integrations/tokemetry/batcher.js';
import {
  MockIngestServer,
  INGEST_ENDPOINT_PATH,
} from './mock-ingest-server.js';
import type { CanonicalUsageEvent } from '../../../src/lifecycle/usage-event.js';

const TOKEN = 'export-token';

function canonical(
  id: string,
  overrides: Partial<CanonicalUsageEvent> = {},
): CanonicalUsageEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    logicalRequestId: 'l',
    attemptId: 'a',
    eventKind: 'attempt',
    finality: 'final',
    sequence: 0,
    timestampStarted: '2026-01-01T00:00:00.000Z',
    provider: 'anthropic',
    nativeModel: 'claude-sonnet-4-20250514',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteShortTokens: 0,
    cacheWriteLongTokens: 0,
    ...overrides,
  } as CanonicalUsageEvent;
}

function harness() {
  const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
  const server = new MockIngestServer({ token: TOKEN });
  let time = 0;
  const batcher = new TokemetryBatcher(
    {
      endpoint: `http://mock${INGEST_ENDPOINT_PATH}`,
      token: TOKEN,
      maxAttempts: 3,
      baseBackoffMs: 1000,
      mapperConfig: { project: { mode: 'omit' } },
    },
    { outbox, transport: server.transport(), now: () => time },
  );
  return {
    outbox,
    server,
    batcher,
    setTime: (t: number) => {
      time = t;
    },
  };
}

describe('happy path', () => {
  it('exports a batch and marks it exported', async () => {
    const { outbox, server, batcher } = harness();
    outbox.enqueue(canonical('e1'), 0);
    outbox.enqueue(canonical('e2'), 0);
    const result = await batcher.flushOnce();
    expect(result).toMatchObject({ claimed: 2, exported: 2, dead: 0 });
    expect(
      server
        .events()
        .map((e) => e.event_id)
        .sort(),
    ).toEqual(['e1', 'e2']);
    expect(outbox.counts()).toMatchObject({ pending: 0, exported: 2 });
  });
});

describe('retry with backoff', () => {
  it('retries a retryable failure after the backoff elapses', async () => {
    const { outbox, server, batcher, setTime } = harness();
    outbox.enqueue(canonical('e1'), 0);
    server.injectFailures(1, 503);

    const first = await batcher.flushOnce();
    expect(first).toMatchObject({ exported: 0, retried: 1 });
    expect(outbox.counts().pending).toBe(1);

    // Before backoff elapses: nothing is claimed.
    setTime(500);
    expect((await batcher.flushOnce()).claimed).toBe(0);

    // After backoff: exported.
    setTime(1000);
    expect((await batcher.flushOnce()).exported).toBe(1);
    expect(server.events()).toHaveLength(1);
  });
});

describe('poison splitting', () => {
  it('isolates a poison event to the DLQ and exports the healthy ones', async () => {
    const { outbox, server, batcher } = harness();
    outbox.enqueue(canonical('good-1'), 0);
    outbox.enqueue(canonical('poison', { outputTokens: -5 }), 0); // rejected by the server
    outbox.enqueue(canonical('good-2'), 0);

    const result = await batcher.flushOnce();
    expect(result.exported).toBe(2);
    expect(result.dead).toBe(1);
    expect(
      server
        .events()
        .map((e) => e.event_id)
        .sort(),
    ).toEqual(['good-1', 'good-2']);
    expect(outbox.deadLetters().map((r) => r.event_id)).toEqual(['poison']);
  });
});

describe('dead-lettering after max attempts', () => {
  it('moves an event to the DLQ once retries are exhausted', async () => {
    const { outbox, server, batcher, setTime } = harness();
    outbox.enqueue(canonical('e1'), 0);
    server.injectFailures(100, 500); // always fails

    let t = 0;
    for (let i = 0; i < 3; i += 1) {
      setTime(t);
      await batcher.flushOnce();
      t += 10 * 60 * 1000; // jump past any backoff
    }
    expect(outbox.counts().dead).toBe(1);
    expect(outbox.deadLetters()[0].event_id).toBe('e1');
  });
});
