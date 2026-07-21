/**
 * Routing-log sink (epic AIPP-3, subtask 3.4).
 *
 * Appends one JSONL v2 record per attempt to routing-log.jsonl. Records carry
 * attempt-linkage fields (logicalRequestId, attemptId, attemptIndex) so AIPP-10
 * can correlate cascade hops as structured attempts rather than console logs.
 * Content never appears here.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageEventSink } from '../../lifecycle/event-sinks.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';
import { dataFile, DATA_FILES } from './paths.js';

/** A single routing-log v2 record. */
export interface RoutingLogRecord {
  schemaVersion: 2;
  timestamp: string;
  logicalRequestId: string;
  attemptId: string;
  attemptIndex: number;
  provider: string;
  requestedModel: string;
  routedModel: string;
  nativeModel: string;
  outcome: string;
  success: boolean;
  httpStatus?: number;
  latencyMs: number;
  fallbackFrom?: string;
  fallbackTrigger?: string;
  policy?: string;
  reason?: string;
}

export interface RoutingLogSinkOptions {
  dir?: string;
}

/** Serialize a canonical event into a routing-log record (allowlist copy). */
export function toRoutingLogRecord(
  event: CanonicalUsageEvent,
): RoutingLogRecord {
  return {
    schemaVersion: 2,
    timestamp: event.timestampCompleted,
    logicalRequestId: event.logicalRequestId,
    attemptId: event.attemptId,
    attemptIndex: event.routing.attemptIndex,
    provider: event.provider,
    requestedModel: event.requestedModel,
    routedModel: event.routedModel,
    nativeModel: event.nativeModel,
    outcome: event.outcome,
    success: event.success,
    httpStatus: event.httpStatus,
    latencyMs: event.latencyMs,
    fallbackFrom: event.routing.fallbackFrom,
    fallbackTrigger: event.routing.fallbackTrigger,
    policy: event.routing.policy,
    reason: event.routing.reason,
  };
}

export class RoutingLogSink implements UsageEventSink {
  readonly name = 'routing-log';
  private readonly path: string;

  constructor(options: RoutingLogSinkOptions = {}) {
    this.path = dataFile(DATA_FILES.routingLog, options.dir);
  }

  onAttemptFinal(event: CanonicalUsageEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(
      this.path,
      `${JSON.stringify(toRoutingLogRecord(event))}\n`,
      'utf8',
    );
  }
}
