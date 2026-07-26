/**
 * Memory-endpoint integration (epic AIPP-11, subtask 11.5).
 *
 * The read-only mesh/memory endpoints are behind the management-auth rule and
 * 404 when mesh is disabled.
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
import type { Config } from '../../src/config/index.js';
import { MeshStore } from '../../src/ops/mesh/index.js';

function get(
  url: string,
  headers: Record<string, string> = {},
): GatewayRequest {
  return { method: 'GET', url, headers, body: '' };
}

function harness(config: Config, mesh?: MeshStore) {
  const deps: GatewayDeps = {
    config,
    registry: buildProviderRegistry({ env: {} as NodeJS.ProcessEnv }),
    mesh,
  };
  return createGateway(deps);
}

function meshConfig(over: (c: Config) => void = () => {}): Config {
  const config = defaultConfig();
  config.mesh.enabled = true;
  over(config);
  return config;
}

describe('memory endpoints', () => {
  it('404s when mesh is disabled', async () => {
    const gateway = harness(defaultConfig());
    const res = await gateway.handle(get('/v1/mesh/stats'));
    expect(res.status).toBe(404);
  });

  it('serves stats, semantic, and episodic memory on loopback', async () => {
    const store = new MeshStore({ database: new Database(':memory:') });
    store.captureAtom({ kind: 'fact', content: { a: 1 } });
    store.captureEpisode({
      sessionId: 's1',
      model: 'm',
      outcome: 'success',
      inputTokens: 1,
      outputTokens: 1,
    });
    const gateway = harness(meshConfig(), store);

    const stats = await gateway.handle(get('/v1/mesh/stats'));
    expect(stats.status).toBe(200);
    expect(JSON.parse(stats.body)).toEqual({ atoms: 1, episodes: 1 });

    const semantic = await gateway.handle(get('/v1/memory/semantic'));
    expect(JSON.parse(semantic.body).atoms).toHaveLength(1);

    const episodic = await gateway.handle(
      get('/v1/memory/episodic?session=s1'),
    );
    expect(JSON.parse(episodic.body).events).toHaveLength(1);
  });

  it('requires a token on a non-loopback deployment', async () => {
    const store = new MeshStore({ database: new Database(':memory:') });
    const config = meshConfig((c) => {
      c.server.host = '0.0.0.0';
      c.server.accessToken = 'secret';
    });
    const gateway = harness(config, store);

    const denied = await gateway.handle(get('/v1/mesh/stats'));
    expect(denied.status).toBe(403);

    const allowed = await gateway.handle(
      get('/v1/mesh/stats', { authorization: 'Bearer secret' }),
    );
    expect(allowed.status).toBe(200);
  });
});
