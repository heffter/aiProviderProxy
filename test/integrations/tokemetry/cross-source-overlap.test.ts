/**
 * Cross-source dedup overlap (Task 18; D-002, AC-006).
 *
 * The whole cross-source dedup design rests on one property: the proxy sets the
 * ingest `event_id` to the **provider request id**, so the transcript collector
 * -- which observes the same upstream request -- computes the same id, and the
 * server's keep-max upsert collapses both reports into one `usage_events` row.
 *
 * The live half of AC-006 (a real Claude Code session with the real collector
 * running) needs a running server and is covered by
 * `test/live/tokemetry-overlap.mjs`. What is testable offline -- and what these
 * tests pin -- is the part that can silently regress in this repo:
 *
 *   1. a provider request id survives end to end, response header -> ingest
 *      `event_id`, so the two sources actually agree on the key;
 *   2. two reports from *different sources* sharing that id collapse to one row
 *      rather than double-counting;
 *   3. the fallback hash id (no provider id) is proxy-only, so it can never
 *      collide with a collector report.
 *
 * Without (1) the collapse would silently stop happening in production while
 * every existing dedup test -- which supplies `eventId` directly -- kept
 * passing.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createGateway } from '../../../src/gateway/server.js';
import { buildProviderRegistry } from '../../../src/gateway/providers.js';
import { defaultConfig } from '../../../src/config/index.js';
import { EventSinkRegistry } from '../../../src/lifecycle/index.js';
import {
  TokemetryOutbox,
  mapToIngest,
} from '../../../src/integrations/tokemetry/index.js';
import type { CanonicalUsageEvent } from '../../../src/lifecycle/usage-event.js';
import type { Transport } from '../../../src/providers/types.js';
import {
  MockIngestServer,
  INGEST_ENDPOINT_PATH,
} from './mock-ingest-server.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-envkey',
  OPENAI_API_KEY: 'sk-openai-envkey',
} as NodeJS.ProcessEnv;

const anthropicBody = JSON.stringify({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1200, output_tokens: 340 },
});

/** Run one Messages request whose upstream returns the given response headers. */
async function runRequest(headers: Record<string, string>): Promise<{
  events: CanonicalUsageEvent[];
  outbox: TokemetryOutbox;
}> {
  const events: CanonicalUsageEvent[] = [];
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onLogicalRequestFinal: (e) => {
      events.push(e);
    },
  });
  const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
  const transport: Transport = async () => ({
    status: 200,
    headers,
    body: anthropicBody,
  });
  const gateway = createGateway({
    config: defaultConfig(),
    registry: buildProviderRegistry({ env }),
    transport,
    sinks,
    outbox,
  });
  const res = await gateway.handle({
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-claude-code-session-id': 'sess-1',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  expect(res.status).toBe(200);
  await sinks.drain();
  return { events, outbox };
}

/**
 * A transcript-collector-shaped report for the same upstream request.
 *
 * Deliberately not a copy of the proxy's payload: it carries the user-facing
 * dimensions the collector observes and omits the routing detail only the proxy
 * sees. That difference is what makes this an overlap rather than a repeat.
 */
function collectorRow(eventId: string): Record<string, unknown> {
  return {
    event_id: eventId,
    schema_version: 2,
    event_kind: 'attempt',
    finality: 'final',
    sequence: 0,
    timestamp_started: '2026-08-06T12:00:00.000Z',
    timestamp_completed: '2026-08-06T12:00:01.000Z',
    provider: 'anthropic',
    requested_model: 'claude-sonnet-4-5',
    input_tokens: 1200,
    output_tokens: 340,
    success: true,
    outcome: 'success',
    streaming: false,
    provenance: 'local_estimate',
    source: {
      type: 'collector',
      name: 'claude-code-transcript-collector',
      version: '1.0.0',
    },
    extra: { collector: { project: 'aiproviderproxy', session_id: 'sess-1' } },
  };
}

/** POST a batch to the mock server through its pure request handler. */
function post(server: MockIngestServer, events: unknown[], token = 'tkm_test') {
  const res = server.handle({
    url: INGEST_ENDPOINT_PATH,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ schema_version: 2, events }),
  });
  return JSON.parse(res.body) as Record<string, unknown>;
}

describe('provider request id reaches the ingest event_id', () => {
  it('carries the Anthropic request-id header through to event_id', async () => {
    const { events } = await runRequest({ 'request-id': 'req_ant_abc' });
    expect(events).toHaveLength(1);
    // This is the key both sources independently arrive at.
    expect(events[0].eventId).toBe('req_ant_abc');
    expect(mapToIngest(events[0], { proxyVersion: 't' }).event_id).toBe(
      'req_ant_abc',
    );
  });

  it('falls back to a deterministic id when the upstream sends no request id', async () => {
    const { events } = await runRequest({});
    // No provider id: the collector cannot compute this, so a fallback-id event
    // is proxy-only and can never be double-counted (FR-USAGE-004).
    expect(events[0].eventId).toMatch(/^evt_[0-9a-f]{32}$/);
  });

  it('derives the same event_id for two observers of one request', async () => {
    // Two independent runs of the same upstream request id agree on the key --
    // the property that lets a separate process (the collector) match it.
    const a = await runRequest({ 'request-id': 'req_shared' });
    const b = await runRequest({ 'request-id': 'req_shared' });
    expect(a.events[0].eventId).toBe(b.events[0].eventId);
    // ...while the logical request ids differ, so the match is not accidental.
    expect(a.events[0].logicalRequestId).not.toBe(b.events[0].logicalRequestId);
  });
});

describe('two sources reporting one request collapse to one row', () => {
  it('keeps a single usage_events row for the shared event_id', async () => {
    const server = new MockIngestServer({ token: 'tkm_test' });
    const { events } = await runRequest({ 'request-id': 'req_overlap' });
    const proxyRow = mapToIngest(events[0], {
      machine: 'host-1',
      proxyVersion: '2.0.0',
    });

    post(server, [proxyRow]);
    // The collector reports the same upstream request, independently.
    post(server, [collectorRow('req_overlap')]);

    // Exactly one row survives: no double counting. This -- not the response
    // body -- is the AC-006 invariant. (The real v2 server additionally answers
    // `duplicate: 1`; this double reports only `accepted`, so the live harness
    // covers the response shape.)
    const rows = server.events().filter((r) => r.event_id === 'req_overlap');
    expect(rows).toHaveLength(1);
  });

  it('does not merge reports of two genuinely different requests', async () => {
    const server = new MockIngestServer({ token: 'tkm_test' });
    const a = await runRequest({ 'request-id': 'req_a' });
    const b = await runRequest({ 'request-id': 'req_b' });
    post(server, [
      mapToIngest(a.events[0], { proxyVersion: 't' }),
      mapToIngest(b.events[0], { proxyVersion: 't' }),
    ]);
    // The collapse is keyed on the id, not applied indiscriminately.
    expect(server.events()).toHaveLength(2);
  });

  it('cannot collide a proxy-only fallback id with a collector report', async () => {
    const server = new MockIngestServer({ token: 'tkm_test' });
    const { events } = await runRequest({}); // no provider request id
    const proxyRow = mapToIngest(events[0], { proxyVersion: 't' });
    post(server, [proxyRow]);

    // A collector report for the same conversation uses the provider request
    // id it saw; it can never equal the proxy's hash fallback.
    post(server, [collectorRow('req_from_transcript')]);
    expect(server.events()).toHaveLength(2);
    expect(proxyRow.event_id).not.toBe('req_from_transcript');
  });

  it('keeps the highest sequence when both sources report the same id', () => {
    const server = new MockIngestServer({ token: 'tkm_test' });
    // The collector reports first with sequence 0...
    post(server, [collectorRow('req_seq')]);
    // ...then the proxy reports a later snapshot of the same request.
    post(server, [
      { ...collectorRow('req_seq'), sequence: 3, output_tokens: 999 },
    ]);
    const rows = server.events().filter((r) => r.event_id === 'req_seq');
    expect(rows).toHaveLength(1);
    expect(rows[0].sequence).toBe(3);
    // Keep-max means token counts come from the winning report only.
    expect(
      (rows[0] as unknown as { output_tokens: number }).output_tokens,
    ).toBe(999);
  });
});
