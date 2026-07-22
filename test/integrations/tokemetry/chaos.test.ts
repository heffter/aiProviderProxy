/**
 * Exporter chaos and privacy suite (epic AIPP-5, subtask 5.6; NFR-REL, NFR-PRIV).
 *
 * Proves the durability guarantee (nothing is lost after outbox commit, even
 * across a simulated forced kill and a flaky network) and that exported ingest
 * payloads carry no request/response content even when the canonical event is
 * poisoned.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TokemetryOutbox } from '../../../src/integrations/tokemetry/outbox.js';
import { TokemetryBatcher } from '../../../src/integrations/tokemetry/batcher.js';
import {
  MockIngestServer,
  INGEST_ENDPOINT_PATH,
} from './mock-ingest-server.js';
import type {
  Transport,
  TransportRequest,
} from '../../../src/providers/types.js';
import type { CanonicalUsageEvent } from '../../../src/lifecycle/usage-event.js';

const TOKEN = 'chaos-token';

function canonical(
  id: string,
  overrides: Partial<CanonicalUsageEvent> = {},
): CanonicalUsageEvent {
  return {
    schemaVersion: 1,
    eventId: id,
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

function makeBatcher(
  outbox: TokemetryOutbox,
  transport: Transport,
  now: () => number,
  maxAttempts = 10,
) {
  return new TokemetryBatcher(
    {
      endpoint: `http://mock${INGEST_ENDPOINT_PATH}`,
      token: TOKEN,
      maxAttempts,
      baseBackoffMs: 1000,
      mapperConfig: { project: { mode: 'omit' } },
    },
    { outbox, transport, now },
  );
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipp-chaos-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('durability across a forced kill', () => {
  it('loses nothing committed to the outbox before the crash', async () => {
    const path = join(dir, 'outbox.db');
    // Process A: commit 20 events, then "die" (close without exporting).
    const first = new TokemetryOutbox({ path });
    for (let i = 0; i < 20; i += 1) {
      first.enqueue(canonical(`e${i}`), 0);
    }
    first.close();

    // Process B: reopen the same DB and drain to the ingest server.
    const outbox = new TokemetryOutbox({ path });
    const server = new MockIngestServer({ token: TOKEN });
    const batcher = makeBatcher(outbox, server.transport(), () => 0);
    while ((await batcher.flushOnce()).claimed > 0) {
      /* drain */
    }
    expect(server.events()).toHaveLength(20); // nothing lost
    expect(outbox.counts()).toMatchObject({
      pending: 0,
      exported: 20,
      dead: 0,
    });
    outbox.close();
  });
});

describe('flaky network eventually delivers everything', () => {
  it('recovers from a burst of failures without losing events', async () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    const server = new MockIngestServer({ token: TOKEN });
    for (let i = 0; i < 5; i += 1) {
      outbox.enqueue(canonical(`e${i}`), 0);
    }
    server.injectFailures(3, 503); // three transient failures up front

    let time = 0;
    const batcher = makeBatcher(outbox, server.transport(), () => time);
    for (let i = 0; i < 8 && outbox.counts().pending > 0; i += 1) {
      await batcher.flushOnce();
      time += 10 * 60 * 1000; // jump past backoff each round
    }
    expect(server.events()).toHaveLength(5);
    expect(outbox.counts()).toMatchObject({ pending: 0, dead: 0, exported: 5 });
    outbox.close();
  });
});

describe('event conservation with poison', () => {
  it('every event ends exported or dead -- none vanish', async () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    const server = new MockIngestServer({ token: TOKEN });
    outbox.enqueue(canonical('ok-1'), 0);
    outbox.enqueue(canonical('poison', { outputTokens: -1 }), 0);
    outbox.enqueue(canonical('ok-2'), 0);

    const batcher = makeBatcher(outbox, server.transport(), () => 0);
    while ((await batcher.flushOnce()).claimed > 0) {
      /* drain */
    }
    const counts = outbox.counts();
    expect(counts.exported + counts.dead).toBe(3); // conservation
    expect(counts.dead).toBe(1);
    outbox.close();
  });
});

describe('privacy: exported payloads are content-free', () => {
  it('never sends content even from a poisoned canonical event', async () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    const server = new MockIngestServer({ token: TOKEN });
    const bodies: string[] = [];
    const recording: Transport = async (req: TransportRequest) => {
      bodies.push(req.body ?? '');
      return server.handle(req);
    };

    const poisoned = canonical('e-priv');
    (poisoned as unknown as Record<string, unknown>).promptText =
      'MARKER_PROMPT_secret';
    (poisoned as unknown as Record<string, unknown>).messages = [
      { content: 'MARKER_MESSAGE_secret' },
    ];
    outbox.enqueue(poisoned, 0);

    const batcher = makeBatcher(outbox, recording, () => 0);
    await batcher.flushOnce();

    const sent = bodies.join('');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain('MARKER_PROMPT_secret');
    expect(sent).not.toContain('MARKER_MESSAGE_secret');
    expect(sent).not.toMatch(/promptText|"messages"/);
    outbox.close();
  });
});
