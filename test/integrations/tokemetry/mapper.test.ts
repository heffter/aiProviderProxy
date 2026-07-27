/**
 * Unit tests for the canonical-to-ingest mapper (epic AIPP-5, subtask 5.2).
 */

import { describe, it, expect } from 'vitest';
import {
  dedupeByEventId,
  mapToIngest,
} from '../../../src/integrations/tokemetry/mapper.js';
import type { IngestEvent } from '../../../src/integrations/tokemetry/mapper.js';
import type { CanonicalUsageEvent } from '../../../src/lifecycle/usage-event.js';

function canonical(
  overrides: Partial<CanonicalUsageEvent> = {},
): CanonicalUsageEvent {
  return {
    schemaVersion: 1,
    eventId: 'req_provider_1',
    logicalRequestId: 'l',
    attemptId: 'a',
    eventKind: 'attempt',
    finality: 'final',
    sequence: 0,
    timestampStarted: '2026-01-01T00:00:00.000Z',
    timestampCompleted: '2026-01-01T00:00:01.000Z',
    clientProtocol: 'anthropic_messages',
    upstreamProtocol: 'anthropic',
    provider: 'anthropic',
    requestedModel: 'claude-sonnet-4',
    routedModel: 'claude-sonnet-4',
    nativeModel: 'claude-sonnet-4-20250514',
    sessionId: 'sess-1',
    project: 'my-secret-project',
    inputTokens: 100,
    outputTokens: 25,
    cacheReadTokens: 7,
    cacheWriteShortTokens: 1024,
    cacheWriteLongTokens: 2048,
    reasoningTokens: 5,
    success: true,
    outcome: 'success',
    httpStatus: 200,
    serviceTier: 'standard',
    latencyMs: 1200,
    timeToFirstTokenMs: 300,
    streaming: true,
    toolCallCount: 2,
    routing: { attemptIndex: 0 },
    provenance: 'provider_reported',
    costEstimateUsd: 0.0031,
    extra: {},
    ...overrides,
  } as CanonicalUsageEvent;
}

describe('mapToIngest', () => {
  const ingest = mapToIngest(canonical(), {
    machine: 'workstation',
    proxyVersion: '2.0.0',
    project: { mode: 'raw' },
  });

  it('maps the v2 usage-event fields (event_id = provider request id)', () => {
    expect(ingest).toMatchObject({
      schema_version: 2,
      event_id: 'req_provider_1',
      event_kind: 'attempt',
      finality: 'final',
      sequence: 0,
      provider: 'anthropic',
      native_model: 'claude-sonnet-4-20250514',
      requested_model: 'claude-sonnet-4',
      routed_model: 'claude-sonnet-4',
      machine: 'workstation',
      session_id: 'sess-1',
      ts_started: '2026-01-01T00:00:00.000Z',
      ts_completed: '2026-01-01T00:00:01.000Z',
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 7,
      cache_write_short_tokens: 1024,
      cache_write_long_tokens: 2048,
      reasoning_tokens: 5,
      success: true,
      outcome: 'success',
      http_status: 200,
      service_tier: 'standard',
      streaming: true,
      latency_ms: 1200,
      time_to_first_token_ms: 300,
      tool_call_count: 2,
      provenance: 'local_estimate',
      source: { type: 'gateway', name: 'aiproviderproxy', version: '2.0.0' },
      routing: { attempt_index: 0 },
    });
  });

  it('never sends cost_usd; puts the estimate under the gateway namespace', () => {
    expect(ingest).not.toHaveProperty('cost_usd');
    expect(ingest).not.toHaveProperty('observed_cost');
    expect(ingest.extra.gateway).toMatchObject({
      cost_estimate_usd: 0.0031,
      client_protocol: 'anthropic_messages',
      upstream_protocol: 'anthropic',
    });
  });

  it('is content-free and does not leak the raw project under the default mode', () => {
    // Default project mode is hash, so the raw name never leaves the machine.
    const clean = mapToIngest(canonical(), { machine: 'workstation' });
    expect(JSON.stringify(clean)).not.toContain('my-secret-project');
    const contentKeys = [
      'messages',
      'content',
      'prompt',
      'system',
      'tools',
      'choices',
      'input',
    ];
    for (const key of contentKeys) {
      expect(clean, key).not.toHaveProperty(key);
      expect(clean.extra.gateway, `extra.gateway.${key}`).not.toHaveProperty(
        key,
      );
    }
  });
});

describe('project modes', () => {
  it('omit -> no project; hash -> hashed; alias -> configured value', () => {
    expect(
      mapToIngest(canonical(), { project: { mode: 'omit' } }).project,
    ).toBeUndefined();
    expect(
      mapToIngest(canonical(), { project: { mode: 'hash' } }).project,
    ).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(
      mapToIngest(canonical(), { project: { mode: 'alias', value: 'team-x' } })
        .project,
    ).toBe('team-x');
    expect(mapToIngest(canonical(), { project: { mode: 'raw' } }).project).toBe(
      'my-secret-project',
    );
  });

  it('defaults to hashing the project so raw names do not leak', () => {
    expect(mapToIngest(canonical()).project).toMatch(/^sha256:/);
  });
});

describe('dedupeByEventId (cross-source keep-max)', () => {
  it('keeps the highest sequence / final event per event_id', () => {
    const mk = (seq: number, finality: IngestEvent['finality']): IngestEvent =>
      mapToIngest(canonical({ sequence: seq, finality }), {
        project: { mode: 'omit' },
      });
    const deduped = dedupeByEventId([
      mk(0, 'snapshot'),
      mk(1, 'snapshot'),
      mk(1, 'final'),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ sequence: 1, finality: 'final' });
  });
});
