/**
 * RequestContext (epic AIPP-3, subtask 3.1; FR-PROTO-001..015).
 *
 * The provider-neutral record of one logical request from accept to completion.
 * It holds a stable logical_request_id, the client protocol, identity/session
 * metadata, and the ordered list of upstream {@link Attempt}s (retries and
 * fallbacks share one monotonically increasing attemptIndex). It never holds
 * prompt or response content.
 */

import {
  Attempt,
  systemClock,
  uuidGen,
  type AttemptInit,
  type Clock,
  type IdGen,
  type TerminalState,
} from './attempt.js';

/** Client-facing protocol the request arrived on. */
export type ClientProtocol =
  'anthropic_messages' | 'openai_responses' | 'openai_chat';

/** Fields fixed when a request is accepted. */
export interface RequestContextInit {
  clientProtocol: ClientProtocol;
  requestedModel: string;
  sessionId?: string;
  project?: string;
  machine?: string;
  agentId?: string;
  streaming?: boolean;
}

/** Injectable clock/id sources for deterministic tests. */
export interface LifecycleDeps {
  clock?: Clock;
  genId?: IdGen;
}

export class RequestContext {
  readonly logicalRequestId: string;
  readonly clientProtocol: ClientProtocol;
  readonly requestedModel: string;
  readonly startedWall: string;
  readonly attempts: Attempt[] = [];

  sessionId?: string;
  project?: string;
  machine?: string;
  agentId?: string;
  streaming: boolean;
  completedWall?: string;
  terminalState?: TerminalState;

  private readonly clock: Clock;
  private readonly genId: IdGen;

  constructor(init: RequestContextInit, deps: LifecycleDeps = {}) {
    this.clock = deps.clock ?? systemClock;
    this.genId = deps.genId ?? uuidGen;
    this.logicalRequestId = this.genId();
    this.clientProtocol = init.clientProtocol;
    this.requestedModel = init.requestedModel;
    this.sessionId = init.sessionId;
    this.project = init.project;
    this.machine = init.machine;
    this.agentId = init.agentId;
    this.streaming = init.streaming ?? false;
    this.startedWall = this.clock.wall();
  }

  /**
   * Begin a new upstream attempt. The attemptIndex increases across retries and
   * fallbacks (0, 1, 2, ...).
   */
  startAttempt(init: AttemptInit): Attempt {
    const attempt = new Attempt(
      this.genId(),
      this.attempts.length,
      init,
      this.clock,
    );
    this.attempts.push(attempt);
    return attempt;
  }

  /** The most recent attempt, if any. */
  get latestAttempt(): Attempt | undefined {
    return this.attempts[this.attempts.length - 1];
  }

  /** Mark the logical request terminal. No-op if already completed. */
  complete(state: TerminalState): void {
    if (this.completedWall !== undefined) {
      return;
    }
    this.completedWall = this.clock.wall();
    this.terminalState = state;
  }

  get isTerminal(): boolean {
    return this.completedWall !== undefined;
  }
}
