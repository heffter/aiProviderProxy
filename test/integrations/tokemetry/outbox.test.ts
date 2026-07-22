/**
 * Unit tests for the Tokemetry durable outbox (epic AIPP-5, subtask 5.1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TokemetryOutbox } from '../../../src/integrations/tokemetry/outbox.js';
import type { CanonicalUsageEvent } from '../../../src/lifecycle/usage-event.js';

function event(id: string, sequence = 0): CanonicalUsageEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    logicalRequestId: 'l',
    attemptId: 'a',
    eventKind: 'attempt',
    finality: 'final',
    sequence,
    inputTokens: 10,
    outputTokens: 5,
  } as unknown as CanonicalUsageEvent;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipp-outbox-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('enqueue / claim / export', () => {
  it('commits an event and claims it as pending', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    outbox.enqueue(event('e1'), 1000);
    const batch = outbox.claimBatch(10, 1000);
    expect(batch).toHaveLength(1);
    expect(batch[0].event_id).toBe('e1');
    expect(batch[0].state).toBe('pending');

    outbox.markExported([batch[0].id]);
    expect(outbox.claimBatch(10, 1000)).toHaveLength(0);
    expect(outbox.counts()).toMatchObject({ pending: 0, exported: 1 });
    outbox.close();
  });
});

describe('retry backoff and dead-lettering', () => {
  it('honours next_attempt_at and moves poison rows to the DLQ', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    const id = outbox.enqueue(event('e1'), 0);

    outbox.markFailed([id], 5000, 'HTTP 500');
    expect(outbox.claimBatch(10, 1000)).toHaveLength(0); // still backing off
    expect(outbox.claimBatch(10, 5000)).toHaveLength(1); // backoff elapsed

    outbox.markDead([id], 'exhausted retries');
    expect(outbox.claimBatch(10, 10_000)).toHaveLength(0);
    expect(outbox.deadLetters().map((r) => r.event_id)).toEqual(['e1']);
    expect(outbox.counts().dead).toBe(1);
    outbox.close();
  });
});

describe('durability across restart (commit-before-export)', () => {
  it('recovers pending events after the process is killed', () => {
    const path = join(dir, 'outbox.db');
    // First "process": commit an event, then simulate a crash (just close/drop).
    const first = new TokemetryOutbox({ path });
    first.enqueue(event('e-durable'), 1000);
    first.close();

    // Second "process": reopen the same file -- the event must still be pending.
    const second = new TokemetryOutbox({ path });
    const batch = second.claimBatch(10, 2000);
    expect(batch).toHaveLength(1);
    expect(batch[0].event_id).toBe('e-durable');
    second.close();
  });
});

describe('retention', () => {
  it('purges exported rows older than the cutoff', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    const id = outbox.enqueue(event('old'), 1000);
    outbox.markExported([id]);
    expect(outbox.purgeExported(2000)).toBe(1);
    expect(outbox.counts().exported).toBe(0);
    outbox.close();
  });
});
