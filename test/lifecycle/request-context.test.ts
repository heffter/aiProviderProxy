/**
 * Unit tests for RequestContext and Attempt (epic AIPP-3, subtask 3.1).
 */

import { describe, it, expect } from 'vitest';
import { RequestContext } from '../../src/lifecycle/request-context.js';
import { type Clock, type IdGen } from '../../src/lifecycle/attempt.js';

/** A deterministic clock: wall ticks by second, mono by 10ms, per call. */
function fakeClock(): Clock {
  let mono = 0;
  let wallMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  return {
    wall: () => {
      const iso = new Date(wallMs).toISOString();
      wallMs += 1000;
      return iso;
    },
    mono: () => {
      const v = mono;
      mono += 10;
      return v;
    },
  };
}

/** Deterministic id generator: id-0, id-1, ... */
function counterGen(): IdGen {
  let n = 0;
  return () => `id-${n++}`;
}

function newCtx() {
  return new RequestContext(
    {
      clientProtocol: 'anthropic_messages',
      requestedModel: 'claude-sonnet-4',
      streaming: true,
    },
    { clock: fakeClock(), genId: counterGen() },
  );
}

describe('RequestContext ids and metadata', () => {
  it('assigns a stable logical_request_id at accept time', () => {
    const ctx = newCtx();
    expect(ctx.logicalRequestId).toBe('id-0');
    expect(ctx.logicalRequestId).toBe(ctx.logicalRequestId); // stable
    expect(ctx.clientProtocol).toBe('anthropic_messages');
    expect(ctx.startedWall).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('attempt indexing across retries and fallbacks', () => {
  it('increments attemptIndex sequentially', () => {
    const ctx = newCtx();
    const a0 = ctx.startAttempt({
      provider: 'anthropic',
      upstreamProtocol: 'anthropic',
      routedModel: 'claude-sonnet-4',
      nativeModel: 'claude-sonnet-4',
    });
    const a1 = ctx.startAttempt({
      provider: 'anthropic',
      upstreamProtocol: 'anthropic',
      routedModel: 'claude-haiku',
      nativeModel: 'claude-haiku',
      routing: { fallbackFrom: 'claude-sonnet-4', fallbackTrigger: '529' },
    });
    const a2 = ctx.startAttempt({
      provider: 'openai',
      upstreamProtocol: 'openai',
      routedModel: 'gpt-4o',
      nativeModel: 'gpt-4o',
      routing: { fallbackFrom: 'anthropic' },
    });

    expect([a0.attemptIndex, a1.attemptIndex, a2.attemptIndex]).toEqual([
      0, 1, 2,
    ]);
    expect(ctx.attempts).toHaveLength(3);
    expect(a0.attemptId).not.toBe(a1.attemptId);
    expect(ctx.latestAttempt).toBe(a2);
    expect(a1.routing.fallbackTrigger).toBe('529');
  });
});

describe('timing capture', () => {
  it('captures TTFT and latency from the monotonic clock', () => {
    const ctx = newCtx();
    const a = ctx.startAttempt({
      provider: 'anthropic',
      upstreamProtocol: 'anthropic',
      routedModel: 'm',
      nativeModel: 'm',
    });
    // started mono = 20 (after ctx used mono 0,10 for wall? no: mono only on mono()); track via ticks
    a.markFirstToken();
    a.markFirstToken(); // idempotent
    a.complete('success', 200);

    expect(a.timeToFirstTokenMs).toBeGreaterThan(0);
    expect(a.latencyMs).toBeGreaterThan(a.timeToFirstTokenMs ?? 0);
    expect(a.firstTokenWall).toBeDefined();
    expect(a.completedWall).toBeDefined();
  });

  it('reports zero latency and undefined TTFT before completion', () => {
    const ctx = newCtx();
    const a = ctx.startAttempt({
      provider: 'p',
      upstreamProtocol: 'p',
      routedModel: 'm',
      nativeModel: 'm',
    });
    expect(a.isTerminal).toBe(false);
    expect(a.latencyMs).toBe(0);
    expect(a.timeToFirstTokenMs).toBeUndefined();
  });
});

describe('terminal state transitions', () => {
  it('records the first terminal state and ignores later ones', () => {
    const ctx = newCtx();
    const a = ctx.startAttempt({
      provider: 'p',
      upstreamProtocol: 'p',
      routedModel: 'm',
      nativeModel: 'm',
    });
    a.complete('upstream_error', 529);
    a.complete('success', 200); // ignored
    expect(a.terminalState).toBe('upstream_error');
    expect(a.httpStatus).toBe(529);
    expect(a.isTerminal).toBe(true);
  });

  it('completes the logical request once', () => {
    const ctx = newCtx();
    ctx.complete('success');
    ctx.complete('timeout'); // ignored
    expect(ctx.terminalState).toBe('success');
    expect(ctx.isTerminal).toBe(true);
  });
});
