/**
 * Per-upstream-call Attempt (epic AIPP-3, subtask 3.1; FR-PROTO-001..015).
 *
 * An Attempt records one call to an upstream provider within a logical request:
 * stable ids, UTC wall-clock timestamps for reporting, a monotonic clock for
 * accurate latency, TTFT capture for streaming, and a terminal state. Timing and
 * id sources are injectable so the whole lifecycle is deterministic under test.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** Terminal outcome of an attempt or logical request. */
export const TERMINAL_STATES = [
  'success',
  'client_cancelled',
  'upstream_error',
  'timeout',
  'policy_rejected',
  'validation_error',
  'internal_error',
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** Routing decision context attached to an attempt. */
export interface RoutingContext {
  policy?: string;
  reason?: string;
  fallbackFrom?: string;
  fallbackTrigger?: string;
  accountLabel?: string;
}

/** Wall-clock (UTC ISO-8601) plus a monotonic millisecond reading. */
export interface Clock {
  wall(): string;
  mono(): number;
}

/** Default clock: system wall clock + high-resolution monotonic clock. */
export const systemClock: Clock = {
  wall: () => new Date().toISOString(),
  mono: () => performance.now(),
};

/** Id generator (injected for deterministic tests). */
export type IdGen = () => string;
export const uuidGen: IdGen = () => randomUUID();

/** Fields fixed when an attempt is created. */
export interface AttemptInit {
  provider: string;
  upstreamProtocol: string;
  routedModel: string;
  nativeModel: string;
  routing?: RoutingContext;
}

/** One upstream call within a logical request. */
export class Attempt {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly provider: string;
  readonly upstreamProtocol: string;
  readonly routedModel: string;
  readonly nativeModel: string;
  readonly routing: RoutingContext;
  readonly startedWall: string;

  private readonly clock: Clock;
  private readonly startedMono: number;
  private firstTokenMono?: number;
  private completedMono?: number;

  firstTokenWall?: string;
  completedWall?: string;
  terminalState?: TerminalState;
  httpStatus?: number;

  constructor(
    attemptId: string,
    attemptIndex: number,
    init: AttemptInit,
    clock: Clock,
  ) {
    this.attemptId = attemptId;
    this.attemptIndex = attemptIndex;
    this.provider = init.provider;
    this.upstreamProtocol = init.upstreamProtocol;
    this.routedModel = init.routedModel;
    this.nativeModel = init.nativeModel;
    this.routing = {
      ...(init.routing ?? {}),
      attemptIndex,
    } as RoutingContext & {
      attemptIndex: number;
    };
    this.clock = clock;
    this.startedWall = clock.wall();
    this.startedMono = clock.mono();
  }

  /** Record time-to-first-token for streaming. No-op after the first call. */
  markFirstToken(): void {
    if (this.firstTokenMono === undefined) {
      this.firstTokenMono = this.clock.mono();
      this.firstTokenWall = this.clock.wall();
    }
  }

  /** Mark the attempt terminal. No-op if already completed. */
  complete(state: TerminalState, httpStatus?: number): void {
    if (this.completedMono !== undefined) {
      return;
    }
    this.completedMono = this.clock.mono();
    this.completedWall = this.clock.wall();
    this.terminalState = state;
    this.httpStatus = httpStatus;
  }

  get isTerminal(): boolean {
    return this.completedMono !== undefined;
  }

  /** Wall-to-wall latency in ms (monotonic); 0 until completed. */
  get latencyMs(): number {
    if (this.completedMono === undefined) {
      return 0;
    }
    return Math.max(0, Math.round(this.completedMono - this.startedMono));
  }

  /** Time to first token in ms, or undefined if none captured. */
  get timeToFirstTokenMs(): number | undefined {
    if (this.firstTokenMono === undefined) {
      return undefined;
    }
    return Math.max(0, Math.round(this.firstTokenMono - this.startedMono));
  }
}
