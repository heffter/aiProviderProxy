/**
 * Routing-log sink (epic AIPP-3, subtask 3.4; wired for cascade in AIPP-10, 10.2).
 *
 * Appends one JSONL v2 record per attempt to routing-log.jsonl. Records carry
 * attempt-linkage fields (logicalRequestId, attemptId, attemptIndex, fallbackFrom,
 * fallbackTrigger) so cascade hops correlate as structured attempts rather than
 * console logs. Superseded fallback attempts arrive as attempt-final events; the
 * winning (or final-error) attempt arrives as the logical-request event -- both
 * are recorded, so the log holds exactly one record per attempt. Content never
 * appears here.
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

  private append(event: CanonicalUsageEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(
      this.path,
      `${JSON.stringify(toRoutingLogRecord(event))}\n`,
      'utf8',
    );
  }

  /** A superseded fallback hop. */
  onAttemptFinal(event: CanonicalUsageEvent): void {
    this.append(event);
  }

  /** The winning (or final-error) attempt of a logical request. */
  onLogicalRequestFinal(event: CanonicalUsageEvent): void {
    this.append(event);
  }
}
