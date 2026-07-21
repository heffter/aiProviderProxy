/**
 * Unit tests for the event sink registry (epic AIPP-3, subtask 3.3).
 */

import { describe, it, expect } from 'vitest';
import {
  EventSinkRegistry,
  type UsageEventSink,
} from '../../src/lifecycle/event-sinks.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';

function fakeEvent(sequence: number): CanonicalUsageEvent {
  return {
    logicalRequestId: 'l',
    attemptId: 'a',
    sequence,
    eventKind: 'attempt',
    finality: 'final',
  } as unknown as CanonicalUsageEvent;
}

describe('failure isolation', () => {
  it('a throwing sink does not affect other sinks or the caller', async () => {
    const warnings: string[] = [];
    const registry = new EventSinkRegistry({ warn: (m) => warnings.push(m) });
    const received: number[] = [];

    registry.register({
      name: 'boom',
      onAttemptFinal: () => {
        throw new Error('sink exploded');
      },
    });
    registry.register({
      name: 'good',
      onAttemptFinal: (e) => {
        received.push(e.sequence);
      },
    });

    // emit must not throw even though a sink throws
    expect(() => registry.emitAttemptFinal(fakeEvent(1))).not.toThrow();
    await registry.drain();

    expect(received).toEqual([1]);
    expect(registry.getStats('boom')?.errors).toBe(1);
    expect(registry.getStats('good')?.delivered).toBe(1);
    expect(warnings.some((w) => w.includes('boom'))).toBe(true);
  });
});

describe('backpressure (drop-oldest)', () => {
  it('drops the oldest events when the queue is full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const received: number[] = [];
    const slow: UsageEventSink = {
      name: 'slow',
      onAttemptFinal: async (e) => {
        await gate;
        received.push(e.sequence);
      },
    };
    const registry = new EventSinkRegistry({ queueLimit: 2, warn: () => {} });
    registry.register(slow);

    for (let i = 0; i < 5; i += 1) {
      registry.emitAttemptFinal(fakeEvent(i));
    }
    // event 0 is in-flight; events 1 and 2 were dropped as newer ones arrived.
    expect(registry.getStats('slow')?.dropped).toBe(2);

    release();
    await registry.drain();

    expect(received).toEqual([0, 3, 4]);
    expect(registry.getStats('slow')?.delivered).toBe(3);
  });
});

describe('ordering', () => {
  it('delivers events per sink in FIFO order', async () => {
    const registry = new EventSinkRegistry();
    const received: number[] = [];
    registry.register({
      name: 'ordered',
      onAttemptFinal: async (e) => {
        received.push(e.sequence);
      },
    });
    for (let i = 0; i < 5; i += 1) {
      registry.emitAttemptFinal(fakeEvent(i));
    }
    await registry.drain();
    expect(received).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('registration and dispatch by kind', () => {
  it('routes each emit to the matching handler and supports unregister', async () => {
    const registry = new EventSinkRegistry();
    const seen: string[] = [];
    registry.register({
      name: 's',
      onSnapshot: () => {
        seen.push('snapshot');
      },
      onLogicalRequestFinal: () => {
        seen.push('logical');
      },
    });

    registry.emitSnapshot(fakeEvent(0));
    registry.emitLogicalRequestFinal(fakeEvent(0));
    registry.emitAttemptFinal(fakeEvent(0)); // no handler -> ignored
    await registry.drain();
    expect(seen).toEqual(['snapshot', 'logical']);

    registry.unregister('s');
    expect(registry.getStats('s')).toBeUndefined();
  });
});
