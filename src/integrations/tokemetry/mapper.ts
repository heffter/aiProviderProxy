/**
 * Canonical-to-ingest mapper (epic AIPP-5, subtask 5.2; PRD 11.15, D-002,
 * FR-USAGE-003, FR-TOK).
 *
 * Maps a CanonicalUsageEvent to a Tokemetry `usage_events` ingest row by
 * explicit field copy. The event_id is the provider request id (carried through
 * from the canonical event) so proxy-reported events dedupe against the Claude
 * Code transcript collector's events for the same request via the server's
 * event_id keep-max upsert -- this is the cross-source dedup design (D-002).
 *
 * `cost_usd` is never sent (the server computes it); the local estimate goes to
 * extra.aipp.cost_estimate_usd. provenance is always "local_estimate". The row
 * is content-free (the canonical event carries no content).
 */

import { createHash } from 'node:crypto';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';

/** How the project dimension is reported. */
export type ProjectMode = 'raw' | 'alias' | 'hash' | 'omit';

/** Mapper configuration (subset of integrations.tokemetry config). */
export interface MapperConfig {
  machine?: string;
  project?: { mode: ProjectMode; value?: string };
  proxyVersion?: string;
}

/** A Tokemetry ingest event (usage_events row). */
export interface IngestEvent {
  event_id: string;
  sequence: number;
  finality: 'snapshot' | 'final';
  provider: string;
  machine_id?: string;
  session_id?: string;
  ts: string;
  model: string;
  project?: string;
  entrypoint: 'proxy';
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_short_tokens: number;
  cache_write_long_tokens: number;
  service_tier?: string;
  provenance: 'local_estimate';
  source: 'aiproviderproxy';
  extra: { aipp: Record<string, unknown> };
}

function resolveProject(
  event: CanonicalUsageEvent,
  config: MapperConfig,
): string | undefined {
  const mode = config.project?.mode ?? 'hash';
  const raw = config.project?.value ?? event.project;
  if (mode === 'omit' || raw === undefined) {
    return undefined;
  }
  if (mode === 'raw') {
    return raw;
  }
  if (mode === 'alias') {
    return config.project?.value ?? raw;
  }
  // hash
  return `sha256:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

/** Map a canonical event to a Tokemetry ingest row (explicit copy, content-free). */
export function mapToIngest(
  event: CanonicalUsageEvent,
  config: MapperConfig = {},
): IngestEvent {
  return {
    event_id: event.eventId,
    sequence: event.sequence,
    finality: event.finality,
    provider: event.provider,
    machine_id: config.machine,
    session_id: event.sessionId,
    ts: event.timestampStarted,
    model: event.nativeModel,
    project: resolveProject(event, config),
    entrypoint: 'proxy',
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_tokens: event.cacheReadTokens,
    cache_write_short_tokens: event.cacheWriteShortTokens,
    cache_write_long_tokens: event.cacheWriteLongTokens,
    service_tier: event.serviceTier,
    provenance: 'local_estimate',
    source: 'aiproviderproxy',
    extra: {
      aipp: {
        client_protocol: event.clientProtocol,
        upstream_protocol: event.upstreamProtocol,
        requested_model: event.requestedModel,
        routed_model: event.routedModel,
        outcome: event.outcome,
        http_status: event.httpStatus,
        latency_ms: event.latencyMs,
        ttft_ms: event.timeToFirstTokenMs,
        streaming: event.streaming,
        tool_call_count: event.toolCallCount,
        routing: event.routing,
        reasoning_tokens: event.reasoningTokens,
        cost_estimate_usd: event.costEstimateUsd,
        proxy_version: config.proxyVersion,
        schema_version: event.schemaVersion,
      },
    },
  };
}

/**
 * Collapse ingest events sharing an event_id to the one with the highest
 * sequence (final wins), mirroring the server's keep-max upsert so a batch never
 * carries redundant snapshots of the same event.
 */
export function dedupeByEventId(events: IngestEvent[]): IngestEvent[] {
  const byId = new Map<string, IngestEvent>();
  for (const event of events) {
    const existing = byId.get(event.event_id);
    if (
      !existing ||
      event.sequence > existing.sequence ||
      (event.sequence === existing.sequence &&
        event.finality === 'final' &&
        existing.finality !== 'final')
    ) {
      byId.set(event.event_id, event);
    }
  }
  return [...byId.values()];
}
