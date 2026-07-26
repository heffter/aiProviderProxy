/**
 * Mesh episodic sink (epic AIPP-11, subtask 11.5).
 *
 * A lifecycle consumer that records one episodic event per completed logical
 * request into the local mesh store. Metadata only (model, outcome, token
 * counts, session) -- never prompt or response content -- and no network I/O.
 */

import type { UsageEventSink } from '../../lifecycle/event-sinks.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';
import type { MeshStore } from './store.js';

export class MeshSink implements UsageEventSink {
  readonly name = 'mesh';

  constructor(private readonly store: MeshStore) {}

  onLogicalRequestFinal(event: CanonicalUsageEvent): void {
    this.store.captureEpisode({
      sessionId: event.sessionId,
      model: event.nativeModel,
      outcome: event.outcome,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
    });
  }
}
