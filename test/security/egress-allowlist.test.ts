/**
 * Egress allowlist suite (epic AIPP-12, subtask 12.4; NFR-SEC-009,
 * FR-IDENT-004).
 *
 * Exercises the local subsystems (CLI commands, config, health/status views)
 * under a fetch interceptor and fails on any outbound hostname that is not a
 * configured provider base URL or the Tokemetry endpoint. Includes a meta-test:
 * a deliberately rogue fetch must be flagged, proving the guard has teeth.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from '../../src/cli/cli.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { withEgressGuard } from '../helpers/egress-guard.js';

/** All provider base-URL hosts plus the Tokemetry endpoint. */
function allowlist(): string[] {
  const registry = buildProviderRegistry({ env: {} as NodeJS.ProcessEnv });
  const ids = [
    'anthropic',
    'openai',
    'google',
    'ollama',
    'zai',
    'xai',
    'openrouter',
    'deepseek',
    'groq',
    'mistral',
    'together',
    'fireworks',
    'perplexity',
  ];
  const hosts = new Set<string>();
  for (const id of ids) {
    if (registry.has(id)) {
      try {
        hosts.add(new URL(registry.get(id).resolveBaseUrl()).hostname);
      } catch {
        // adapters with no default base URL contribute nothing
      }
    }
  }
  hosts.add('tokemetry.dev'); // the Tokemetry ingest endpoint
  hosts.add('127.0.0.1'); // local ollama default
  hosts.add('localhost');
  return [...hosts];
}

const noop: CliIO = { out: () => {}, err: () => {} };

describe('egress allowlist', () => {
  let dir: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-egress-'));
    savedHome = process.env.AIPP_HOME;
    process.env.AIPP_HOME = dir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AIPP_HOME;
    else process.env.AIPP_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes no disallowed egress while exercising the CLI subsystems', async () => {
    const cfg = join(dir, 'config.json');
    const { violations } = await withEgressGuard(allowlist(), async () => {
      const commands: string[][] = [
        ['help'],
        ['version'],
        ['config', 'show'],
        ['content-log', 'status'],
        ['tokemetry', 'status'],
        ['alerts', 'counts'],
        ['cache', 'stats'],
        ['mesh', 'status'],
        ['policy', 'replay'],
      ];
      for (const argv of commands) {
        await runCli(argv, { io: noop, configFile: cfg });
      }
    });
    expect(violations).toEqual([]);
  });

  it('flags a rogue fetch (meta-test: the guard has teeth)', async () => {
    const { violations } = await withEgressGuard(allowlist(), async () => {
      await fetch('https://osmosis-mesh-dev.fly.dev/mesh/contribute');
      await fetch('https://api.relayplane.com/v1/ping');
    });
    expect(violations).toContain('osmosis-mesh-dev.fly.dev');
    expect(violations).toContain('api.relayplane.com');
  });
});
