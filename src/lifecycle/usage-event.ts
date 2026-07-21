/**
 * CanonicalUsageEvent builder (epic AIPP-3, subtask 3.2; PRD 11.14, FR-USAGE-001..014).
 *
 * The event is assembled by an allowlist serializer: every field is copied
 * explicitly and the request/attempt objects are NEVER spread, so prompt or
 * response content structurally cannot enter an event (FR-USAGE-009).
 *
 * eventId is the provider request id when available, else a deterministic hash
 * of (logicalRequestId, attemptId, provider, model, timestampStarted) so it is
 * stable for replay and dedup (FR-USAGE-003/004). Snapshots of one attempt reuse
 * the eventId with an increasing sequence; the last is flagged final.
 */

import { createHash } from 'node:crypto';
import type { Attempt } from './attempt.js';
import type { ClientProtocol, RequestContext } from './request-context.js';

/** The canonical usage event, schema v1 (PRD section 11.14). */
export interface CanonicalUsageEvent {
  schemaVersion: 1;
  eventId: string;
  logicalRequestId: string;
  attemptId: string;
  eventKind: 'attempt' | 'logical_request';
  finality: 'snapshot' | 'final';
  sequence: number;

  timestampStarted: string;
  timestampFirstToken?: string;
  timestampCompleted: string;

  clientProtocol: ClientProtocol;
  upstreamProtocol: string;

  provider: string;
  requestedModel: string;
  routedModel: string;
  nativeModel: string;

  sessionId?: string;
  project?: string;
  machine?: string;
  agentId?: string;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteShortTokens: number;
  cacheWriteLongTokens: number;
  reasoningTokens?: number;

  success: boolean;
  outcome: string;
  httpStatus?: number;
  providerRequestId?: string;
  providerResponseId?: string;
  stopReason?: string;
  serviceTier?: string;

  latencyMs: number;
  timeToFirstTokenMs?: number;
  streaming: boolean;
  toolCallCount: number;

  routing: {
    policy?: string;
    reason?: string;
    attemptIndex: number;
    fallbackFrom?: string;
    fallbackTrigger?: string;
    accountLabel?: string;
  };

  provenance: 'provider_reported' | 'local_estimate';
  costEstimateUsd?: number;
  extra: Record<string, unknown>;
}

/** Token counts; unknown categories go to {@link UsageTokens.extra} -> extra.usage. */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteShortTokens?: number;
  cacheWriteLongTokens?: number;
  reasoningTokens?: number;
  extra?: Record<string, number>;
}

/** Inputs to {@link buildUsageEvent}. */
export interface UsageEventInput {
  ctx: RequestContext;
  attempt: Attempt;
  eventKind: 'attempt' | 'logical_request';
  finality: 'snapshot' | 'final';
  sequence: number;
  success: boolean;
  outcome: string;
  httpStatus?: number;
  providerRequestId?: string;
  providerResponseId?: string;
  stopReason?: string;
  serviceTier?: string;
  streaming: boolean;
  toolCallCount?: number;
  tokens: UsageTokens;
  provenance: 'provider_reported' | 'local_estimate';
  costEstimateUsd?: number;
  /** Namespaced diagnostics only (extra.anthropic, extra.zai, ...); never content. */
  extra?: Record<string, unknown>;
  /** Override the completion timestamp (e.g. for mid-stream snapshots). */
  timestampCompleted?: string;
}

/** Thrown for invalid usage inputs (e.g. negative token counts). */
export class UsageEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageEventError';
  }
}

/**
 * Derive the event id: the provider request id if present, else a deterministic
 * hash of the attempt identity (FR-USAGE-003/004).
 */
export function deriveEventId(
  providerRequestId: string | undefined,
  parts: {
    logicalRequestId: string;
    attemptId: string;
    provider: string;
    model: string;
    timestampStarted: string;
  },
): string {
  if (providerRequestId) {
    return providerRequestId;
  }
  const hash = createHash('sha256')
    .update(
      [
        parts.logicalRequestId,
        parts.attemptId,
        parts.provider,
        parts.model,
        parts.timestampStarted,
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 32);
  return `evt_${hash}`;
}

function assertNonNegative(name: string, value: number | undefined): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new UsageEventError(
      `${name} must be a non-negative number, got ${String(value)}`,
    );
  }
}

function buildExtra(input: UsageEventInput): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (input.extra) {
    for (const [k, v] of Object.entries(input.extra)) {
      extra[k] = v;
    }
  }
  if (input.tokens.extra && Object.keys(input.tokens.extra).length > 0) {
    extra.usage = { ...input.tokens.extra };
  }
  return extra;
}

/**
 * Build a {@link CanonicalUsageEvent} by explicit field copy. Throws
 * {@link UsageEventError} if any token count is negative.
 */
export function buildUsageEvent(input: UsageEventInput): CanonicalUsageEvent {
  const { ctx, attempt, tokens } = input;

  assertNonNegative('inputTokens', tokens.inputTokens);
  assertNonNegative('outputTokens', tokens.outputTokens);
  assertNonNegative('cacheReadTokens', tokens.cacheReadTokens);
  assertNonNegative('cacheWriteShortTokens', tokens.cacheWriteShortTokens);
  assertNonNegative('cacheWriteLongTokens', tokens.cacheWriteLongTokens);
  assertNonNegative('reasoningTokens', tokens.reasoningTokens);
  for (const [name, value] of Object.entries(tokens.extra ?? {})) {
    assertNonNegative(`extra usage "${name}"`, value);
  }

  const timestampStarted = attempt.startedWall;
  const eventId = deriveEventId(input.providerRequestId, {
    logicalRequestId: ctx.logicalRequestId,
    attemptId: attempt.attemptId,
    provider: attempt.provider,
    model: attempt.nativeModel,
    timestampStarted,
  });

  return {
    schemaVersion: 1,
    eventId,
    logicalRequestId: ctx.logicalRequestId,
    attemptId: attempt.attemptId,
    eventKind: input.eventKind,
    finality: input.finality,
    sequence: input.sequence,

    timestampStarted,
    timestampFirstToken: attempt.firstTokenWall,
    timestampCompleted:
      input.timestampCompleted ??
      attempt.completedWall ??
      attempt.firstTokenWall ??
      timestampStarted,

    clientProtocol: ctx.clientProtocol,
    upstreamProtocol: attempt.upstreamProtocol,

    provider: attempt.provider,
    requestedModel: ctx.requestedModel,
    routedModel: attempt.routedModel,
    nativeModel: attempt.nativeModel,

    sessionId: ctx.sessionId,
    project: ctx.project,
    machine: ctx.machine,
    agentId: ctx.agentId,

    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens ?? 0,
    cacheWriteShortTokens: tokens.cacheWriteShortTokens ?? 0,
    cacheWriteLongTokens: tokens.cacheWriteLongTokens ?? 0,
    reasoningTokens: tokens.reasoningTokens,

    success: input.success,
    outcome: input.outcome,
    httpStatus: input.httpStatus,
    providerRequestId: input.providerRequestId,
    providerResponseId: input.providerResponseId,
    stopReason: input.stopReason,
    serviceTier: input.serviceTier,

    latencyMs: attempt.latencyMs,
    timeToFirstTokenMs: attempt.timeToFirstTokenMs,
    streaming: input.streaming,
    toolCallCount: input.toolCallCount ?? 0,

    routing: {
      policy: attempt.routing.policy,
      reason: attempt.routing.reason,
      attemptIndex: attempt.attemptIndex,
      fallbackFrom: attempt.routing.fallbackFrom,
      fallbackTrigger: attempt.routing.fallbackTrigger,
      accountLabel: attempt.routing.accountLabel,
    },

    provenance: input.provenance,
    costEstimateUsd: input.costEstimateUsd,
    extra: buildExtra(input),
  };
}
