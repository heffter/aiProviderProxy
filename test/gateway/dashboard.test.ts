/**
 * Dashboard endpoint integration (epic AIPP-11, subtask 11.1).
 *
 * The dashboard page and its read-only API are served on the gateway listener
 * behind the management-auth rule; run content is gated by content logging and
 * the exporter panel reflects outbox health.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createGateway,
  type GatewayDeps,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import type { Config } from '../../src/config/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { HistoryEntry } from '../../src/ops/trackers/history-sink.js';

function get(
  url: string,
  headers: Record<string, string> = {},
): GatewayRequest {
  return { method: 'GET', url, headers, body: '' };
}

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 2,
    id: 'r1',
    timestamp: '2026-07-26T12:00:00.000Z',
    provider: 'anthropic',
    requestedModel: 'claude-sonnet-4-5',
    routedModel: 'claude-sonnet-4-5',
    nativeModel: 'claude-sonnet-4-5',
    outcome: 'success',
    success: true,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    latencyMs: 100,
    costEstimateUsd: 0.01,
    content: { request: { secret: 'prompt' } },
    ...over,
  };
}

describe('dashboard endpoints', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-dashgw-'));
    writeFileSync(
      join(dir, 'history.jsonl'),
      JSON.stringify(entry({ id: 'x' })) + '\n',
      'utf8',
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function harness(config: Config) {
    const deps: GatewayDeps = {
      config,
      registry: buildProviderRegistry({ env: {} as NodeJS.ProcessEnv }),
      outbox: new TokemetryOutbox({ database: new Database(':memory:') }),
      dataDir: dir,
    };
    return createGateway(deps);
  }

  it('serves the dashboard page on loopback', async () => {
    const res = await harness(defaultConfig()).handle(get('/'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('aiproviderproxy');
  });

  it('serves the summary and exporter panel', async () => {
    const gateway = harness(defaultConfig());
    const summary = await gateway.handle(get('/api/summary'));
    expect(JSON.parse(summary.body).totalRequests).toBe(1);
    const exporter = await gateway.handle(get('/api/exporter'));
    expect(JSON.parse(exporter.body)).toMatchObject({
      pending: 0,
      dead: 0,
      healthy: true,
    });
  });

  it('hides run content when content logging is off', async () => {
    const off = defaultConfig();
    off.contentLog.enabled = false;
    const runs = await harness(off).handle(get('/api/runs'));
    expect(JSON.parse(runs.body)[0].content).toBeUndefined();

    const on = defaultConfig(); // enabled by default
    const runsOn = await harness(on).handle(get('/api/runs'));
    expect(JSON.parse(runsOn.body)[0].content).toBeDefined();
  });

  it('fetches a single run by id and 404s a missing one', async () => {
    const gateway = harness(defaultConfig());
    expect((await gateway.handle(get('/api/runs/x'))).status).toBe(200);
    expect((await gateway.handle(get('/api/runs/nope'))).status).toBe(404);
  });

  it('requires a token on a non-loopback deployment', async () => {
    const config = defaultConfig();
    config.server.host = '0.0.0.0';
    config.server.accessToken = 'secret';
    const gateway = harness(config);
    expect((await gateway.handle(get('/'))).status).toBe(403);
    expect((await gateway.handle(get('/api/summary'))).status).toBe(403);
    expect(
      (await gateway.handle(get('/api/summary', { 'x-aipp-token': 'secret' })))
        .status,
    ).toBe(200);
  });
});
