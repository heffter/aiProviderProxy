/**
 * Performance benchmark (epic AIPP-13, subtask 13.1; NFR-PERF-001..006).
 *
 * Measures the gateway's added overhead and the telemetry hot paths against a
 * near-zero mock transport, so the numbers isolate the proxy's own cost rather
 * than provider latency. Run explicitly (it is NOT part of the coverage gate, to
 * avoid timing flakiness in CI):
 *
 *   npx vitest run test/perf/benchmark.test.ts --config vitest.gates.config.ts
 *
 * Targets (documented in docs/architecture/performance-baseline.md):
 *   - non-streaming gateway overhead p95 < 50 ms
 *   - outbox insert p95 < 5 ms
 *   - exporter throughput >= 1000 events/sec (synthetic)
 * Assertions use generous bounds so an occasional scheduling hiccup does not
 * fail the run; the printed percentiles are the reported baseline.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  createGateway,
  type GatewayDeps,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { Transport } from '../../src/providers/types.js';

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

function stats(samples: number[]): { p50: number; p95: number; p99: number } {
  const s = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
  };
}

const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-envkey' } as NodeJS.ProcessEnv;

const anthropicOk = JSON.stringify({
  id: 'msg_ok',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
});

function usageEvent(i: number) {
  return {
    schemaVersion: 1,
    eventId: `evt-${i}`,
    logicalRequestId: `lr-${i}`,
    attemptId: `at-${i}`,
    eventKind: 'logical_request',
    finality: 'final',
    sequence: 0,
    timestampStarted: '2026-07-26T12:00:00.000Z',
    timestampCompleted: '2026-07-26T12:00:01.000Z',
    clientProtocol: 'anthropic_messages',
    upstreamProtocol: 'anthropic',
    provider: 'anthropic',
    requestedModel: 'm',
    routedModel: 'm',
    nativeModel: 'm',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteShortTokens: 0,
    cacheWriteLongTokens: 0,
    success: true,
    outcome: 'success',
    latencyMs: 1,
    streaming: false,
    toolCallCount: 0,
    routing: { attemptIndex: 0 },
    provenance: 'provider_reported',
    extra: {},
  } as never;
}

describe('performance baseline', () => {
  it('non-streaming gateway overhead', async () => {
    const transport: Transport = async () => ({
      status: 200,
      headers: { 'request-id': 'r' },
      body: anthropicOk,
    });
    const deps: GatewayDeps = {
      config: defaultConfig(),
      registry: buildProviderRegistry({ env }),
      transport,
    };
    const gateway = createGateway(deps);
    const req: GatewayRequest = {
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    };
    for (let i = 0; i < 200; i++) await gateway.handle(req); // warm up

    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const t0 = performance.now();
      await gateway.handle(req);
      samples.push(performance.now() - t0);
    }
    const s = stats(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] non-streaming overhead p50=${s.p50.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms p99=${s.p99.toFixed(3)}ms`,
    );
    expect(s.p95).toBeLessThan(50);
  });

  it('outbox insert latency', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    const samples: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const t0 = performance.now();
      outbox.enqueue(usageEvent(i), 1000 + i);
      samples.push(performance.now() - t0);
    }
    const s = stats(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] outbox insert p50=${s.p50.toFixed(4)}ms p95=${s.p95.toFixed(4)}ms p99=${s.p99.toFixed(4)}ms`,
    );
    expect(s.p95).toBeLessThan(5);
  });

  it('exporter drain throughput', () => {
    const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
    const N = 5000;
    for (let i = 0; i < N; i++) outbox.enqueue(usageEvent(i), 1000);

    const t0 = performance.now();
    let processed = 0;
    for (;;) {
      const batch = outbox.claimBatch(500, 2000);
      if (batch.length === 0) break;
      outbox.markExported(batch.map((r) => r.id));
      processed += batch.length;
    }
    const elapsedSec = (performance.now() - t0) / 1000;
    const rate = processed / elapsedSec;
    // eslint-disable-next-line no-console
    console.log(
      `[perf] exporter throughput ${Math.round(rate)} events/sec (${processed} in ${elapsedSec.toFixed(3)}s)`,
    );
    expect(processed).toBe(N);
    expect(rate).toBeGreaterThan(1000);
  });
});
