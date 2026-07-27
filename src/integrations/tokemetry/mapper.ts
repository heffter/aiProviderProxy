/**
 * Canonical-to-ingest mapper (epic AIPP-5, subtask 5.2; reconciled to the live
 * Tokemetry v2 ingest contract in AIPP-13.4; PRD 11.15, D-002, FR-USAGE-003).
 *
 * Maps a CanonicalUsageEvent to a Tokemetry v2 `usage_events` ingest row
 * (`POST /api/v2/ingest/events`) by explicit field copy. The v2 event model is a
 * near-1:1 match for the canonical event: attempt vs logical_request kind,
 * finality/sequence, provider request/response ids, routing metadata, and token
 * counts. The event_id is the provider request id (carried through) so
 * proxy-reported events dedupe against the transcript collector's events for the
 * same request via the server's event_id upsert -- the cross-source dedup design
 * (D-002).
 *
 * Cost is never sent (the server prices it); the local estimate goes to
 * extra.aipp.cost_estimate_usd. provenance is always "local_estimate". The row is
 * content-free. The v2 event is strict (additionalProperties=false), so only
 * schema fields are emitted; gateway-specific detail lives under `extra.aipp`.
 */

import { createHash } from 'node:crypto';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';

/** How the project dimension is reported. */
export type ProjectMode = 'raw' | 'alias' | 'hash' | 'omit';

/** Mapper configuration (subset of integrations.tokemetry config). */
export interface MapperConfig {
  machine?: string;
  project?: { mode: ProjectMode; value?: string };
  /** The gateway version reported as the ingest source version. */
  proxyVersion?: string;
  /** The source name (defaults to `aiproviderproxy`). */
  sourceName?: string;
}

/** The ingest source identity (v2 SourceRef). */
export interface IngestSource {
  type: 'gateway';
  name: string;
  version: string;
}

/** Routing metadata on a v2 ingest event (snake_case; strict). */
export interface IngestRouting {
  policy?: string;
  reason?: string;
  attempt_index: number;
  fallback_from?: string;
  fallback_trigger?: string;
}

/** A Tokemetry v2 ingest event (usage_events row). */
export interface IngestEvent {
  schema_version: 2;
  event_id: string;
  event_kind: 'attempt' | 'logical_request';
  finality: 'snapshot' | 'final';
  sequence: number;
  logical_request_id?: string;
  attempt_id?: string;
  provider_request_id?: string;
  provider_response_id?: string;
  provider: string;
  native_model: string;
  requested_model?: string;
  routed_model?: string;
  ts_started: string;
  ts_first_token?: string;
  ts_completed?: string;
  machine?: string;
  project?: string;
  session_id?: string;
  agent_id?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_short_tokens: number;
  cache_write_long_tokens: number;
  reasoning_tokens?: number;
  success: boolean;
  outcome?: string;
  http_status?: number;
  stop_reason?: string;
  service_tier?: string;
  streaming: boolean;
  latency_ms: number;
  time_to_first_token_ms?: number;
  tool_call_count: number;
  provenance: 'local_estimate';
  source: IngestSource;
  routing?: IngestRouting;
  /** Gateway-specific detail under the allowed `gateway` namespace. */
  extra: { gateway: Record<string, unknown> };
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

/**
 * Map a canonical event to a v2 Tokemetry ingest row (explicit copy,
 * content-free). Only v2 schema fields are set; the `routing.account_label` and
 * client/upstream protocol detail live under `extra.aipp`.
 */
export function mapToIngest(
  event: CanonicalUsageEvent,
  config: MapperConfig = {},
): IngestEvent {
  // A canonical event always carries a routing block; default defensively so a
  // malformed event can never crash the content-free export path.
  const r = event.routing ?? { attemptIndex: 0 };
  const routing: IngestRouting = {
    policy: r.policy,
    reason: r.reason,
    attempt_index: r.attemptIndex,
    fallback_from: r.fallbackFrom,
    fallback_trigger: r.fallbackTrigger,
  };
  return {
    schema_version: 2,
    event_id: event.eventId,
    event_kind: event.eventKind,
    finality: event.finality,
    sequence: event.sequence,
    logical_request_id: event.logicalRequestId,
    attempt_id: event.attemptId,
    provider_request_id: event.providerRequestId,
    provider_response_id: event.providerResponseId,
    provider: event.provider,
    native_model: event.nativeModel,
    requested_model: event.requestedModel,
    routed_model: event.routedModel,
    ts_started: event.timestampStarted,
    ts_first_token: event.timestampFirstToken,
    ts_completed: event.timestampCompleted,
    machine: config.machine,
    project: resolveProject(event, config),
    session_id: event.sessionId,
    agent_id: event.agentId,
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_tokens: event.cacheReadTokens,
    cache_write_short_tokens: event.cacheWriteShortTokens,
    cache_write_long_tokens: event.cacheWriteLongTokens,
    reasoning_tokens: event.reasoningTokens,
    success: event.success,
    outcome: event.outcome,
    http_status: event.httpStatus,
    stop_reason: event.stopReason,
    service_tier: event.serviceTier,
    streaming: event.streaming,
    latency_ms: event.latencyMs,
    time_to_first_token_ms: event.timeToFirstTokenMs,
    tool_call_count: event.toolCallCount,
    provenance: 'local_estimate',
    source: {
      type: 'gateway',
      name: config.sourceName ?? 'aiproviderproxy',
      version: config.proxyVersion ?? '0.0.0',
    },
    routing,
    extra: {
      gateway: {
        client_protocol: event.clientProtocol,
        upstream_protocol: event.upstreamProtocol,
        account_label: r.accountLabel,
        cost_estimate_usd: event.costEstimateUsd,
      },
    },
  };
}

/**
 * Collapse ingest events sharing an event_id to the one with the highest
 * sequence (final wins), mirroring the server's event_id upsert so a batch never
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
