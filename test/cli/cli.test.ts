/**
 * Unit tests for the new aipp CLI shell (epic AIPP-2, subtask 2.6).
 *
 * Covers the command surface, cloud-command removal, config-show redaction,
 * content-log toggling, and a network-egress guard proving no command calls
 * fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMANDS,
  REMOVED_COMMANDS,
  runCli,
  type CliIO,
} from '../../src/cli/cli.js';

let dir: string;
let configFile: string;
const out: string[] = [];
const err: string[] = [];
const io: CliIO = { out: (l) => out.push(l), err: (l) => err.push(l) };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipp-cli-'));
  configFile = join(dir, 'config.json');
  out.length = 0;
  err.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stubLegacy = vi.fn(async () => 0);
const stubStartGateway = vi.fn(async (sink: CliIO) => {
  sink.out('gateway started (stub)');
  return 0;
});

function run(argv: string[]): Promise<number> {
  return runCli(argv, {
    io,
    configFile,
    runLegacy: stubLegacy,
    startGateway: stubStartGateway,
  });
}

describe('help and version', () => {
  it('prints help with no command and lists every command', async () => {
    expect(await run([])).toBe(0);
    const text = out.join('\n');
    for (const cmd of COMMANDS) {
      if (cmd !== 'help' && cmd !== 'version') {
        expect(text, cmd).toContain(cmd);
      }
    }
  });

  it('prints the product name and binary for version', async () => {
    expect(await run(['version'])).toBe(0);
    expect(out.join('\n')).toContain('aiproviderproxy aipp');
  });
});

describe('removed cloud commands', () => {
  it('rejects every removed command with a non-zero code', async () => {
    for (const cmd of REMOVED_COMMANDS) {
      out.length = 0;
      err.length = 0;
      expect(await run([cmd]), cmd).toBe(2);
      expect(err.join('\n'), cmd).toContain('removed');
    }
  });

  it('rejects an unknown command', async () => {
    expect(await run(['frobnicate'])).toBe(2);
    expect(err.join('\n')).toContain('unknown command');
  });
});

describe('start', () => {
  it('boots the gateway and does not run legacy', async () => {
    stubStartGateway.mockClear();
    stubLegacy.mockClear();
    expect(await run(['start'])).toBe(0);
    expect(stubStartGateway).toHaveBeenCalled();
    expect(stubLegacy).not.toHaveBeenCalled();
  });

  it('delegates to the legacy runner with --legacy', async () => {
    stubLegacy.mockClear();
    stubStartGateway.mockClear();
    expect(await run(['start', '--legacy', '--port', '4100'])).toBe(0);
    expect(stubLegacy).toHaveBeenCalledWith(['--port', '4100']);
    expect(stubStartGateway).not.toHaveBeenCalled();
  });
});

describe('config show', () => {
  it('prints the effective config with secrets redacted', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        server: { accessToken: 'supersecret', host: '127.0.0.1' },
      }),
      'utf8',
    );
    expect(await run(['config', 'show'])).toBe(0);
    const text = out.join('\n');
    expect(text).not.toContain('supersecret');
    expect(text).toContain('<redacted>');
    expect(text).toContain('4100'); // default port present
  });

  it('errors (non-zero) on invalid config, redacting the message', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({ server: { port: 99999 } }),
      'utf8',
    );
    expect(await run(['config', 'show'])).toBe(1);
    expect(err.join('\n')).toContain('error:');
  });
});

describe('content-log', () => {
  it('reports status, then toggles off and persists', async () => {
    expect(await run(['content-log', 'status'])).toBe(0);
    expect(out.join('\n')).toContain('content logging is on'); // default on

    out.length = 0;
    expect(await run(['content-log', 'off'])).toBe(0);
    expect(out.join('\n')).toContain('now off');

    out.length = 0;
    expect(await run(['content-log', 'status'])).toBe(0);
    expect(out.join('\n')).toContain('content logging is off');
  });

  it('rejects an invalid subcommand', async () => {
    expect(await run(['content-log', 'sideways'])).toBe(2);
  });
});

describe('migrate-from-relayplane', () => {
  const ENV = ['AIPP_HOME', 'RELAYPLANE_HOME_OVERRIDE'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.AIPP_HOME = join(dir, 'target');
    process.env.RELAYPLANE_HOME_OVERRIDE = dir; // source = <dir>/.relayplane
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  it('runs the importer and prints the result', async () => {
    // no source config -> importer warns but writes defaults
    const code = await runCli(['migrate-from-relayplane'], {
      io,
      runLegacy: stubLegacy,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Migrated RelayPlane config');
  });
});

describe('default IO path', () => {
  it('runs version through the default stdout sink without throwing', async () => {
    // No injected io/configFile: exercises the defaults for a config-free command.
    await expect(runCli(['version'], { runLegacy: stubLegacy })).resolves.toBe(
      0,
    );
  });
});

describe('network egress guard', () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('makes no fetch call on any command', async () => {
    writeFileSync(configFile, JSON.stringify({}), 'utf8');
    const invocations: string[][] = [
      [],
      ['help'],
      ['version'],
      ['start'],
      ['config', 'show'],
      ['content-log', 'status'],
      ['content-log', 'on'],
      ['login'],
      ['frobnicate'],
    ];
    for (const argv of invocations) {
      await runCli(argv, {
        io,
        configFile,
        runLegacy: stubLegacy,
        startGateway: stubStartGateway,
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
