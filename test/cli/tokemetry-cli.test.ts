/**
 * Tests for the `aipp tokemetry` CLI command (epic AIPP-5, subtask 5.5).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCli, type CliIO } from '../../src/cli/cli.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/outbox.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';

const event = (id: string) =>
  ({
    eventId: id,
    finality: 'final',
    sequence: 0,
    inputTokens: 1,
    outputTokens: 1,
  }) as unknown as CanonicalUsageEvent;

function collector(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe('aipp tokemetry', () => {
  it('prints exporter status', async () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    outbox.enqueue(event('e1'), 0);
    const { io, out } = collector();
    const code = await runCli(['tokemetry', 'status'], {
      io,
      openTokemetryOutbox: () => outbox,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('tokemetry exporter: healthy');
    expect(out.join('\n')).toContain('pending:  1');
  });

  it('lists dead-lettered events', async () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    const id = outbox.enqueue(event('poison-1'), 0);
    outbox.markDead([id], 'poison: ingest 400');
    const { io, out } = collector();
    const code = await runCli(['tokemetry', 'dlq'], {
      io,
      openTokemetryOutbox: () => outbox,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('1 dead-lettered event');
    expect(out.join('\n')).toContain('poison-1');
  });

  it('rejects an invalid subcommand', async () => {
    const { io } = collector();
    expect(
      await runCli(['tokemetry', 'nope'], {
        io,
        openTokemetryOutbox: () =>
          new TokemetryOutbox({ database: new Database(':memory:') }),
      }),
    ).toBe(2);
  });
});
