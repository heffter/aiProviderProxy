/**
 * Unit tests for the local sink adapters (epic AIPP-3, subtask 3.4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RequestContext } from '../../src/lifecycle/request-context.js';
import { buildUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { Clock, IdGen } from '../../src/lifecycle/attempt.js';
import {
  AgentsSink,
  HistorySink,
  RoutingLogSink,
  SessionsSink,
  TracesSink,
} from '../../src/ops/trackers/index.js';

function fixedClock(): Clock {
  return { wall: () => '2026-01-01T00:00:00.000Z', mono: () => 0 };
}
function counterGen(): IdGen {
  let n = 0;
  return () => `id-${n++}`;
}

function makeEvent(
  overrides: Partial<CanonicalUsageEvent> = {},
): CanonicalUsageEvent {
  const ctx = new RequestContext(
    {
      clientProtocol: 'anthropic_messages',
      requestedModel: 'claude-sonnet-4',
      sessionId: 'sess-1',
      agentId: 'agent-1',
    },
    { clock: fixedClock(), genId: counterGen() },
  );
  const attempt = ctx.startAttempt({
    provider: 'anthropic',
    upstreamProtocol: 'anthropic',
    routedModel: 'claude-sonnet-4',
    nativeModel: 'claude-sonnet-4-20250514',
  });
  attempt.complete('success', 200);
  return {
    ...buildUsageEvent({
      ctx,
      attempt,
      eventKind: 'logical_request',
      finality: 'final',
      sequence: 0,
      success: true,
      outcome: 'success',
      streaming: false,
      tokens: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 7 },
      provenance: 'provider_reported',
      providerRequestId: 'req_123',
    }),
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipp-sinks-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RoutingLogSink', () => {
  it('appends a v2 JSONL record per attempt', () => {
    new RoutingLogSink({ dir }).onAttemptFinal(makeEvent());
    const line = readFileSync(join(dir, 'routing-log.jsonl'), 'utf8').trim();
    const rec = JSON.parse(line);
    expect(rec).toMatchObject({
      schemaVersion: 2,
      provider: 'anthropic',
      attemptIndex: 0,
      outcome: 'success',
      logicalRequestId: expect.any(String),
    });
  });
});

describe('AgentsSink', () => {
  it('upserts a fingerprint registry and counts requests without content', () => {
    const sink = new AgentsSink({ dir });
    sink.onLogicalRequestFinal(makeEvent());
    sink.onLogicalRequestFinal(makeEvent());
    const registry = sink.read();
    expect(registry['agent-1'].requestCount).toBe(2);
    expect(registry['agent-1'].providers).toEqual(['anthropic']);
    expect(JSON.stringify(registry)).not.toContain('prompt');
  });

  it('ignores events with no agentId', () => {
    const sink = new AgentsSink({ dir });
    sink.onLogicalRequestFinal(makeEvent({ agentId: undefined }));
    expect(existsSync(join(dir, 'agents.json'))).toBe(false);
  });
});

describe('HistorySink', () => {
  it('writes metadata-only entries when content logging is off', () => {
    new HistorySink({
      dir,
      contentLogEnabled: false,
      getContent: () => ({ request: 'PROMPT' }),
    }).onLogicalRequestFinal(makeEvent());
    const entry = JSON.parse(
      readFileSync(join(dir, 'history.jsonl'), 'utf8').trim(),
    );
    expect(entry).toMatchObject({ schemaVersion: 2, inputTokens: 100 });
    expect(entry).not.toHaveProperty('content');
  });

  it('captures content only when logging is enabled', () => {
    new HistorySink({
      dir,
      contentLogEnabled: true,
      getContent: () => ({ request: 'PROMPT', response: 'REPLY' }),
    }).onLogicalRequestFinal(makeEvent());
    const entry = JSON.parse(
      readFileSync(join(dir, 'history.jsonl'), 'utf8').trim(),
    );
    expect(entry.content).toEqual({ request: 'PROMPT', response: 'REPLY' });
  });
});

describe('SessionsSink', () => {
  it('upserts per-session aggregates in SQLite', () => {
    const sink = new SessionsSink({ database: new Database(':memory:') });
    sink.onLogicalRequestFinal(makeEvent());
    sink.onLogicalRequestFinal(makeEvent());
    const row = sink.read('sess-1');
    expect(row).toMatchObject({
      session_id: 'sess-1',
      request_count: 2,
      input_tokens: 200,
      output_tokens: 50,
    });
    sink.close();
  });

  it('ignores events with no sessionId', () => {
    const sink = new SessionsSink({ database: new Database(':memory:') });
    sink.onLogicalRequestFinal(makeEvent({ sessionId: undefined }));
    expect(sink.read('sess-1')).toBeUndefined();
    sink.close();
  });
});

describe('TracesSink', () => {
  it('stores hash-only rows, never content', () => {
    const sink = new TracesSink({
      database: new Database(':memory:'),
      getHashes: () => ({ requestHash: 'h1', responseHash: 'h2' }),
    });
    const event = makeEvent();
    sink.onAttemptFinal(event);
    const rows = sink.readByLogical(event.logicalRequestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      request_hash: 'h1',
      response_hash: 'h2',
    });
    expect(Object.keys(rows[0])).not.toContain('content');
    sink.close();
  });
});

describe('legacy-format compatibility', () => {
  it('appends to a history.jsonl that already holds a legacy line', () => {
    const path = join(dir, 'history.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({ id: 'legacy-1', model: 'claude', tokens: 5 })}\n`,
      'utf8',
    );
    new HistorySink({ dir }).onLogicalRequestFinal(makeEvent());
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('legacy-1'); // legacy line intact and parseable
    expect(JSON.parse(lines[1]).schemaVersion).toBe(2);
  });
});
