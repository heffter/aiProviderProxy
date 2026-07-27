/**
 * Runtime composition-root tests (Task 15).
 *
 * Assert that createGatewayRuntime composes the sink registry, subsystem sinks,
 * and Tokemetry export loop strictly per config flags, that credential
 * resolution and endpoint construction are correct, and that shutdown drains
 * sinks, flushes the outbox, and closes every DB cleanly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultConfig, type Config } from '../../src/config/index.js';
import {
  createGatewayRuntime,
  resolveCredential,
} from '../../src/runtime/index.js';
import type { Transport, TransportRequest } from '../../src/providers/types.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';

/** A minimal, valid canonical event the mapper can serialize. */
function canonical(id: string): CanonicalUsageEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    logicalRequestId: 'l',
    attemptId: 'a',
    eventKind: 'attempt',
    finality: 'final',
    sequence: 0,
    timestampStarted: '2026-01-01T00:00:00.000Z',
    provider: 'anthropic',
    nativeModel: 'claude-sonnet-4-20250514',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteShortTokens: 0,
    cacheWriteLongTokens: 0,
  } as CanonicalUsageEvent;
}

/** A transport that records every request and returns a fixed 200 response. */
function recordingTransport(): {
  transport: Transport;
  requests: TransportRequest[];
} {
  const requests: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: JSON.stringify({ accepted: 1 }) };
  };
  return { transport, requests };
}

/** All subsystem enabled, pointed at a temp home. */
function fullConfig(home: string): Config {
  const config = defaultConfig();
  config.server.port = 0; // ephemeral bind for listen tests
  config.budget.enabled = true;
  config.alerts.enabled = true;
  config.anomaly.enabled = true;
  config.mesh.enabled = true;
  config.cache.enabled = true;
  config.integrations.tokemetry.enabled = true;
  config.integrations.tokemetry.baseUrl = 'http://ingest.test';
  config.integrations.tokemetry.credential = {
    type: 'env',
    name: 'AIPP_TEST_TOKEMETRY_TOKEN',
  };
  config.integrations.tokemetry.queuePath = join(home, 'outbox.db');
  return config;
}

describe('createGatewayRuntime composition', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aipp-runtime-'));
  });

  afterEach(() => {
    delete process.env.AIPP_TEST_TOKEMETRY_TOKEN;
    rmSync(home, { recursive: true, force: true });
  });

  it('registers only base observability trackers when subsystems are off', async () => {
    const config = defaultConfig();
    const runtime = createGatewayRuntime(config, { home });
    try {
      for (const name of [
        'history',
        'agents',
        'sessions',
        'traces',
        'routing-log',
      ]) {
        expect(runtime.sinks.getStats(name), name).toBeDefined();
      }
      for (const name of ['budget', 'anomaly-alerts', 'mesh']) {
        expect(runtime.sinks.getStats(name), name).toBeUndefined();
      }
      expect(runtime.outbox).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });

  it('registers subsystem sinks and the outbox when their flags are on', async () => {
    process.env.AIPP_TEST_TOKEMETRY_TOKEN = 'secret-token';
    const runtime = createGatewayRuntime(fullConfig(home), {
      home,
      transport: recordingTransport().transport,
      flushIntervalMs: 60_000,
    });
    try {
      for (const name of ['budget', 'anomaly-alerts', 'mesh']) {
        expect(runtime.sinks.getStats(name), name).toBeDefined();
      }
      expect(runtime.outbox).toBeDefined();
    } finally {
      await runtime.stop();
    }
  });

  it('exports queued events to the v2 ingest endpoint with bearer auth on shutdown', async () => {
    process.env.AIPP_TEST_TOKEMETRY_TOKEN = 'secret-token';
    const { transport, requests } = recordingTransport();
    const runtime = createGatewayRuntime(fullConfig(home), {
      home,
      transport,
      flushIntervalMs: 60_000, // pump idle; only the shutdown flush exports
    });
    runtime.outbox!.enqueue(canonical('e1'), 0);
    runtime.outbox!.enqueue(canonical('e2'), 0);

    await runtime.stop();

    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.url).toBe('http://ingest.test/api/v2/ingest/events');
    expect(post.headers['authorization']).toBe('Bearer secret-token');
    const body = JSON.parse(post.body ?? '{}') as { events?: unknown[] };
    expect(body.events).toHaveLength(2);
  });

  it('queues durably but does not export when enabled with no credential', async () => {
    // No AIPP_TEST_TOKEMETRY_TOKEN set -> credential unresolvable.
    const { transport, requests } = recordingTransport();
    const warnings: string[] = [];
    const runtime = createGatewayRuntime(fullConfig(home), {
      home,
      transport,
      warn: (m) => warnings.push(m),
    });
    runtime.outbox!.enqueue(canonical('e1'), 0);
    await runtime.stop();

    expect(requests).toHaveLength(0);
    expect(warnings.some((w) => w.includes('tokemetry'))).toBe(true);
  });

  it('binds a listener and shuts down cleanly and idempotently', async () => {
    process.env.AIPP_TEST_TOKEMETRY_TOKEN = 'secret-token';
    const runtime = createGatewayRuntime(fullConfig(home), {
      home,
      transport: recordingTransport().transport,
      flushIntervalMs: 60_000,
    });
    const { port } = await runtime.listen();
    expect(port).toBeGreaterThan(0);

    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined(); // idempotent
  });
});

describe('resolveCredential', () => {
  afterEach(() => {
    delete process.env.AIPP_TEST_CRED;
  });

  it('resolves an env credential', () => {
    process.env.AIPP_TEST_CRED = 'env-secret';
    expect(resolveCredential({ type: 'env', name: 'AIPP_TEST_CRED' })).toBe(
      'env-secret',
    );
  });

  it('resolves a file credential and trims whitespace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipp-cred-'));
    const path = join(dir, 'token');
    writeFileSync(path, '  file-secret\n');
    try {
      expect(resolveCredential({ type: 'file', path })).toBe('file-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for an absent ref or empty env var', () => {
    expect(resolveCredential(undefined)).toBeUndefined();
    expect(
      resolveCredential({ type: 'env', name: 'AIPP_TEST_CRED' }),
    ).toBeUndefined();
  });
});
