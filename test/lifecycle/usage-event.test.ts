/**
 * Unit tests for the CanonicalUsageEvent builder (epic AIPP-3, subtask 3.2).
 */

import { describe, it, expect } from 'vitest';
import { RequestContext } from '../../src/lifecycle/request-context.js';
import {
  type Attempt,
  type Clock,
  type IdGen,
} from '../../src/lifecycle/attempt.js';
import {
  buildUsageEvent,
  deriveEventId,
  UsageEventError,
  type UsageEventInput,
} from '../../src/lifecycle/usage-event.js';

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

function counterGen(): IdGen {
  let n = 0;
  return () => `id-${n++}`;
}

function scenario(): { ctx: RequestContext; attempt: Attempt } {
  const ctx = new RequestContext(
    {
      clientProtocol: 'anthropic_messages',
      requestedModel: 'claude-sonnet-4',
      sessionId: 'sess-1',
    },
    { clock: fakeClock(), genId: counterGen() },
  );
  const attempt = ctx.startAttempt({
    provider: 'anthropic',
    upstreamProtocol: 'anthropic',
    routedModel: 'claude-sonnet-4',
    nativeModel: 'claude-sonnet-4-20250514',
  });
  attempt.markFirstToken();
  attempt.complete('success', 200);
  return { ctx, attempt };
}

function baseInput(ctx: RequestContext, attempt: Attempt): UsageEventInput {
  return {
    ctx,
    attempt,
    eventKind: 'attempt',
    finality: 'final',
    sequence: 0,
    success: true,
    outcome: 'success',
    streaming: false,
    tokens: { inputTokens: 100, outputTokens: 25 },
    provenance: 'provider_reported',
  };
}

describe('deriveEventId', () => {
  it('uses the provider request id when present', () => {
    expect(
      deriveEventId('req_abc', {
        logicalRequestId: 'l',
        attemptId: 'a',
        provider: 'anthropic',
        model: 'm',
        timestampStarted: 't',
      }),
    ).toBe('req_abc');
  });

  it('is a deterministic hash when no provider id exists', () => {
    const parts = {
      logicalRequestId: 'l',
      attemptId: 'a',
      provider: 'anthropic',
      model: 'm',
      timestampStarted: 't',
    };
    const a = deriveEventId(undefined, parts);
    const b = deriveEventId(undefined, parts);
    expect(a).toBe(b);
    expect(a).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(deriveEventId(undefined, { ...parts, attemptId: 'other' })).not.toBe(
      a,
    );
  });
});

describe('buildUsageEvent field mapping', () => {
  it('produces a schema-v1 event with UTC timestamps and mapped fields', () => {
    const { ctx, attempt } = scenario();
    const event = buildUsageEvent({
      ...baseInput(ctx, attempt),
      providerRequestId: 'req_upstream',
      tokens: {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 7,
        cacheWriteShortTokens: 2048,
      },
    });
    expect(event.schemaVersion).toBe(1);
    expect(event.eventId).toBe('req_upstream'); // provider id preferred
    expect(event.logicalRequestId).toBe(ctx.logicalRequestId);
    expect(event.clientProtocol).toBe('anthropic_messages');
    expect(event.nativeModel).toBe('claude-sonnet-4-20250514');
    expect(event.cacheReadTokens).toBe(7);
    expect(event.cacheWriteLongTokens).toBe(0); // defaulted
    expect(event.routing.attemptIndex).toBe(0);
    expect(event.timestampStarted).toMatch(/Z$/); // UTC ISO
    expect(new Date(event.timestampCompleted).toISOString()).toBe(
      event.timestampCompleted,
    );
    expect(event.latencyMs).toBeGreaterThan(0);
  });

  it('routes unknown token categories to extra.usage', () => {
    const { ctx, attempt } = scenario();
    const event = buildUsageEvent({
      ...baseInput(ctx, attempt),
      tokens: { inputTokens: 10, outputTokens: 5, extra: { audioTokens: 3 } },
      extra: { anthropic: { beta: 'x' } },
    });
    expect(event.extra).toMatchObject({
      anthropic: { beta: 'x' },
      usage: { audioTokens: 3 },
    });
  });
});

describe('snapshot sequencing', () => {
  it('reuses the eventId across snapshots and flags the final one', () => {
    const { ctx, attempt } = scenario();
    const snap = buildUsageEvent({
      ...baseInput(ctx, attempt),
      finality: 'snapshot',
      sequence: 0,
      providerRequestId: undefined,
    });
    const final = buildUsageEvent({
      ...baseInput(ctx, attempt),
      finality: 'final',
      sequence: 1,
      providerRequestId: undefined,
    });
    expect(snap.eventId).toBe(final.eventId); // same attempt -> same id
    expect(snap.finality).toBe('snapshot');
    expect(final.finality).toBe('final');
    expect(final.sequence).toBe(1);
  });
});

describe('validation', () => {
  it('rejects negative token counts', () => {
    const { ctx, attempt } = scenario();
    expect(() =>
      buildUsageEvent({
        ...baseInput(ctx, attempt),
        tokens: { inputTokens: -1, outputTokens: 5 },
      }),
    ).toThrow(UsageEventError);
    expect(() =>
      buildUsageEvent({
        ...baseInput(ctx, attempt),
        tokens: { inputTokens: 1, outputTokens: 5, extra: { x: -2 } },
      }),
    ).toThrow(UsageEventError);
  });
});

describe('allowlist enforcement (FR-USAGE-009)', () => {
  it('produces a clean event even from a context poisoned with content fields', () => {
    const { ctx, attempt } = scenario();
    (ctx as unknown as Record<string, unknown>).promptText =
      'SECRET_PROMPT_CONTENT';
    (ctx as unknown as Record<string, unknown>).messages = [
      { text: 'SECRET_PROMPT_CONTENT' },
    ];
    (attempt as unknown as Record<string, unknown>).responseBody =
      'SECRET_RESPONSE_CONTENT';

    const event = buildUsageEvent(baseInput(ctx, attempt));
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('SECRET_PROMPT_CONTENT');
    expect(serialized).not.toContain('SECRET_RESPONSE_CONTENT');
    expect(serialized).not.toContain('promptText');
    expect(serialized).not.toContain('responseBody');
  });
});
