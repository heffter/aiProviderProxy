/**
 * Event sink registry with failure isolation (epic AIPP-3, subtask 3.3;
 * FR-PROTO-013/014).
 *
 * Sinks subscribe to lifecycle events (snapshot, attempt-final,
 * logical-request-final). Emission is non-blocking: events are enqueued per sink
 * and drained by an async worker, so a slow or throwing sink can never block or
 * fail the request path. Each sink has a bounded queue; when full, the oldest
 * event is dropped with a rate-limited local warning (non-durable semantics --
 * the durable Tokemetry outbox in AIPP-5 uses a synchronous-commit path
 * instead). Per-sink ordering is FIFO, so events for one logical request arrive
 * in order.
 */

import type { CanonicalUsageEvent } from './usage-event.js';

/** A subscriber to lifecycle usage events. All handlers are optional. */
export interface UsageEventSink {
  name: string;
  /** Marks a sink whose dropped events represent real data loss (warned louder). */
  durable?: boolean;
  onSnapshot?(event: CanonicalUsageEvent): void | Promise<void>;
  onAttemptFinal?(event: CanonicalUsageEvent): void | Promise<void>;
  onLogicalRequestFinal?(event: CanonicalUsageEvent): void | Promise<void>;
}

/** Registry configuration. */
export interface SinkRegistryOptions {
  /** Max queued events per sink before drop-oldest kicks in (default 1000). */
  queueLimit?: number;
  /** Max error warnings emitted per sink before suppression (default 10). */
  errorLimit?: number;
  /** Local warning sink (default: stderr). */
  warn?: (message: string) => void;
}

/** Per-sink runtime counters. */
export interface SinkStats {
  queued: number;
  dropped: number;
  errors: number;
  delivered: number;
}

type EventMethod = 'onSnapshot' | 'onAttemptFinal' | 'onLogicalRequestFinal';

interface SinkState {
  sink: UsageEventSink;
  queue: Array<() => void | Promise<void>>;
  processing: boolean;
  dropped: number;
  errors: number;
  delivered: number;
}

export class EventSinkRegistry {
  private readonly sinks = new Map<string, SinkState>();
  private readonly queueLimit: number;
  private readonly errorLimit: number;
  private readonly warn: (message: string) => void;

  constructor(options: SinkRegistryOptions = {}) {
    this.queueLimit = options.queueLimit ?? 1000;
    this.errorLimit = options.errorLimit ?? 10;
    this.warn =
      options.warn ?? ((m) => process.stderr.write(`[event-sink] ${m}\n`));
  }

  /** Register (or replace) a sink by name. */
  register(sink: UsageEventSink): void {
    this.sinks.set(sink.name, {
      sink,
      queue: [],
      processing: false,
      dropped: 0,
      errors: 0,
      delivered: 0,
    });
  }

  /** Remove a sink by name. */
  unregister(name: string): void {
    this.sinks.delete(name);
  }

  /** Current counters for a sink, or undefined if not registered. */
  getStats(name: string): SinkStats | undefined {
    const state = this.sinks.get(name);
    if (!state) {
      return undefined;
    }
    return {
      queued: state.queue.length,
      dropped: state.dropped,
      errors: state.errors,
      delivered: state.delivered,
    };
  }

  emitSnapshot(event: CanonicalUsageEvent): void {
    this.dispatch('onSnapshot', event);
  }

  emitAttemptFinal(event: CanonicalUsageEvent): void {
    this.dispatch('onAttemptFinal', event);
  }

  emitLogicalRequestFinal(event: CanonicalUsageEvent): void {
    this.dispatch('onLogicalRequestFinal', event);
  }

  /** Resolve once every sink queue is empty and idle (tests/shutdown). */
  async drain(): Promise<void> {
    for (;;) {
      let pending = false;
      for (const state of this.sinks.values()) {
        if (state.queue.length > 0 || state.processing) {
          pending = true;
          break;
        }
      }
      if (!pending) {
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private dispatch(method: EventMethod, event: CanonicalUsageEvent): void {
    for (const state of this.sinks.values()) {
      const handler = state.sink[method];
      if (handler) {
        this.enqueue(state, () => handler.call(state.sink, event));
      }
    }
  }

  private enqueue(state: SinkState, job: () => void | Promise<void>): void {
    if (state.queue.length >= this.queueLimit) {
      state.queue.shift();
      state.dropped += 1;
      const level = state.sink.durable ? 'DATA LOSS' : 'dropped';
      if (state.dropped === 1 || state.dropped % this.queueLimit === 0) {
        this.warn(
          `sink "${state.sink.name}" queue full; ${level} oldest event (total ${state.dropped})`,
        );
      }
    }
    state.queue.push(job);
    if (!state.processing) {
      void this.process(state);
    }
  }

  private async process(state: SinkState): Promise<void> {
    state.processing = true;
    try {
      while (state.queue.length > 0) {
        const job = state.queue.shift();
        if (!job) {
          continue;
        }
        try {
          await job();
          state.delivered += 1;
        } catch (err) {
          this.onSinkError(state, err);
        }
      }
    } finally {
      state.processing = false;
    }
  }

  private onSinkError(state: SinkState, err: unknown): void {
    state.errors += 1;
    if (state.errors <= this.errorLimit) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`sink "${state.sink.name}" handler error: ${message}`);
      if (state.errors === this.errorLimit) {
        this.warn(
          `sink "${state.sink.name}" reached error limit; suppressing further error logs`,
        );
      }
    }
  }
}
