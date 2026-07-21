/**
 * Lifecycle privacy suite (epic AIPP-3, subtask 3.5; NFR-PRIV-001, FR-USAGE-009).
 *
 * Plants distinctive content markers (prompts, messages, tool arguments, file
 * paths, code) into a request/response and a deliberately poisoned lifecycle,
 * then asserts NONE of them survive in the canonical event or in any sink
 * payload -- except the history sink when content logging is explicitly on,
 * which is the one sanctioned content carrier.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** Distinctive content markers that must never leak into events or metadata sinks. */
const MARKERS = {
  prompt: 'MARKER_PROMPT_the_secret_user_question',
  message: 'MARKER_MESSAGE_assistant_reply_body',
  toolArg: 'MARKER_TOOLARG_delete_all_records',
  filePath: 'MARKER_FILEPATH_home_user_secret_key',
  code: 'MARKER_CODE_function_exfiltrate',
};

/** Object keys that content would arrive under; forbidden in clean payloads. */
const PROHIBITED_KEYS = [
  'prompt',
  'promptText',
  'messages',
  'system',
  'systemPrompt',
  'tool_calls',
  'toolCalls',
  'arguments',
  'requestBody',
  'responseBody',
  'fileContent',
];

function collectKeys(
  value: unknown,
  keys: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      collectKeys(v, keys);
    }
  }
  return keys;
}

function assertNoMarkers(serialized: string, label: string): void {
  for (const marker of Object.values(MARKERS)) {
    expect(
      serialized,
      `${label} leaked content marker ${marker}`,
    ).not.toContain(marker);
  }
}

function assertNoProhibitedKeys(value: unknown, label: string): void {
  const keys = collectKeys(value);
  for (const forbidden of PROHIBITED_KEYS) {
    expect(
      [...keys],
      `${label} exposes prohibited key "${forbidden}"`,
    ).not.toContain(forbidden);
  }
}

function poisonedEvent(): {
  event: CanonicalUsageEvent;
  sessionId: string;
  agentId: string;
} {
  let n = 0;
  const genId: IdGen = () => `id-${n++}`;
  const clock: Clock = {
    wall: () => '2026-01-01T00:00:00.000Z',
    mono: () => 0,
  };

  const ctx = new RequestContext(
    {
      clientProtocol: 'anthropic_messages',
      requestedModel: 'claude-sonnet-4',
      sessionId: 'sess-priv',
      agentId: 'agent-priv',
    },
    { clock, genId },
  );
  // Simulate a buggy caller attaching the raw request/response to the context.
  const poison = ctx as unknown as Record<string, unknown>;
  poison.requestBody = {
    system: MARKERS.prompt,
    messages: [{ role: 'user', content: MARKERS.message }],
    tools: [
      {
        name: 'run',
        input: { command: MARKERS.toolArg, path: MARKERS.filePath },
      },
    ],
  };

  const attempt = ctx.startAttempt({
    provider: 'anthropic',
    upstreamProtocol: 'anthropic',
    routedModel: 'claude-sonnet-4',
    nativeModel: 'claude-sonnet-4-20250514',
  });
  (attempt as unknown as Record<string, unknown>).responseBody = {
    content: [{ type: 'text', text: MARKERS.code }],
  };
  attempt.complete('success', 200);

  const event = buildUsageEvent({
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
    providerRequestId: 'req_priv',
    extra: { anthropic: { serviceTier: 'standard' } },
  });
  return { event, sessionId: 'sess-priv', agentId: 'agent-priv' };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipp-priv-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('canonical usage event', () => {
  it('carries no content markers and no prohibited keys', () => {
    const { event } = poisonedEvent();
    assertNoMarkers(JSON.stringify(event), 'canonical event');
    assertNoProhibitedKeys(event, 'canonical event');
  });
});

describe('metadata sinks are content-free', () => {
  it('routing-log sink', () => {
    const { event } = poisonedEvent();
    new RoutingLogSink({ dir }).onAttemptFinal(event);
    const raw = readFileSync(join(dir, 'routing-log.jsonl'), 'utf8');
    assertNoMarkers(raw, 'routing-log');
    assertNoProhibitedKeys(JSON.parse(raw.trim()), 'routing-log');
  });

  it('agents sink', () => {
    const { event } = poisonedEvent();
    new AgentsSink({ dir }).onLogicalRequestFinal(event);
    const raw = readFileSync(join(dir, 'agents.json'), 'utf8');
    assertNoMarkers(raw, 'agents');
    assertNoProhibitedKeys(JSON.parse(raw), 'agents');
  });

  it('sessions sink', () => {
    const { event, sessionId } = poisonedEvent();
    const sink = new SessionsSink({ database: new Database(':memory:') });
    sink.onLogicalRequestFinal(event);
    assertNoMarkers(JSON.stringify(sink.read(sessionId)), 'sessions');
    sink.close();
  });

  it('traces sink (hash-only)', () => {
    const { event } = poisonedEvent();
    const sink = new TracesSink({
      database: new Database(':memory:'),
      getHashes: () => ({ requestHash: 'h1', responseHash: 'h2' }),
    });
    sink.onAttemptFinal(event);
    const rows = sink.readByLogical(event.logicalRequestId);
    assertNoMarkers(JSON.stringify(rows), 'traces');
    assertNoProhibitedKeys(rows, 'traces');
    sink.close();
  });

  it('history sink with content logging OFF', () => {
    const { event } = poisonedEvent();
    new HistorySink({
      dir,
      contentLogEnabled: false,
      getContent: () => ({ request: MARKERS.prompt }),
    }).onLogicalRequestFinal(event);
    assertNoMarkers(
      readFileSync(join(dir, 'history.jsonl'), 'utf8'),
      'history (content off)',
    );
  });
});

describe('history sink is the only sanctioned content carrier', () => {
  it('records content ONLY when content logging is explicitly enabled', () => {
    const { event } = poisonedEvent();
    new HistorySink({
      dir,
      contentLogEnabled: true,
      getContent: () => ({
        request: MARKERS.prompt,
        response: MARKERS.message,
      }),
    }).onLogicalRequestFinal(event);
    const raw = readFileSync(join(dir, 'history.jsonl'), 'utf8');
    // This is the sanctioned exception: content is present by explicit opt-in.
    expect(raw).toContain(MARKERS.prompt);
    expect(raw).toContain(MARKERS.message);
    // ...and it lives under the dedicated `content` field only.
    expect(JSON.parse(raw.trim()).content).toEqual({
      request: MARKERS.prompt,
      response: MARKERS.message,
    });
  });
});
