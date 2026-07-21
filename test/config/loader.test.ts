/**
 * Unit tests for the single config loader (epic AIPP-2, subtask 2.3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  configPath,
  isLoopbackHost,
  loadConfig,
  saveConfig,
} from '../../src/config/loader.js';
import { defaultConfig } from '../../src/config/schema.js';

const ENV_KEYS = [
  'AIPP_CONFIG_PATH',
  'AIPP_HOME',
  'AIPP_PORT',
  'AIPP_HOST',
  'AIPP_ROUTING_MODE',
];
const saved: Record<string, string | undefined> = {};

let dir: string;
let path: string;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'aipp-config-'));
  path = join(dir, 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

describe('path resolution', () => {
  it('honours AIPP_CONFIG_PATH then AIPP_HOME', () => {
    process.env.AIPP_CONFIG_PATH = '/explicit/config.json';
    expect(configPath()).toBe('/explicit/config.json');
    delete process.env.AIPP_CONFIG_PATH;
    process.env.AIPP_HOME = '/home/x';
    expect(configPath()).toBe(join('/home/x', 'config.json'));
  });
});

describe('loadConfig', () => {
  it('returns defaults with no warnings when no file exists', () => {
    const { config, warnings } = loadConfig(path);
    expect(config).toEqual(defaultConfig());
    expect(warnings).toEqual([]);
  });

  it('falls back to defaults with a warning on corrupt JSON', () => {
    writeFileSync(path, '{ not valid json', 'utf8');
    const { config, warnings } = loadConfig(path);
    expect(config.server.port).toBe(4100);
    expect(warnings.some((w) => w.includes('not valid JSON'))).toBe(true);
  });

  it('warns about and preserves unknown top-level keys', () => {
    writeFileSync(
      path,
      JSON.stringify({ experimental: { flag: true } }),
      'utf8',
    );
    const { config, warnings } = loadConfig(path);
    expect(warnings.some((w) => w.includes('experimental'))).toBe(true);
    expect((config as Record<string, unknown>).experimental).toEqual({
      flag: true,
    });
  });

  it('throws an actionable error on a schema-invalid config', () => {
    writeFileSync(path, JSON.stringify({ server: { port: 99999 } }), 'utf8');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('applies non-secret env overrides and warns on invalid ones', () => {
    process.env.AIPP_PORT = '8080';
    process.env.AIPP_ROUTING_MODE = 'cascade';
    expect(loadConfig(path).config.server.port).toBe(8080);
    expect(loadConfig(path).config.routing.mode).toBe('cascade');

    process.env.AIPP_PORT = 'notaport';
    const { config, warnings } = loadConfig(path);
    expect(config.server.port).toBe(4100);
    expect(warnings.some((w) => w.includes('AIPP_PORT'))).toBe(true);
  });
});

describe('FR-AUTH-012 host/token invariant', () => {
  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });

  it('refuses a non-loopback host without an access token', () => {
    writeFileSync(
      path,
      JSON.stringify({ server: { host: '0.0.0.0' } }),
      'utf8',
    );
    expect(() => loadConfig(path)).toThrow(
      /non-loopback|not loopback|FR-AUTH-012/,
    );
  });

  it('allows a non-loopback host with an access token', () => {
    writeFileSync(
      path,
      JSON.stringify({ server: { host: '0.0.0.0', accessToken: 't0ken' } }),
      'utf8',
    );
    expect(loadConfig(path).config.server.host).toBe('0.0.0.0');
  });
});

describe('saveConfig atomic write with backup', () => {
  it('round-trips and backs up the prior file on rewrite', () => {
    const first = defaultConfig();
    saveConfig(first, path);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false); // temp cleaned up (rename)
    expect(loadConfig(path).config).toEqual(first);

    const second = { ...first, server: { ...first.server, port: 5000 } };
    saveConfig(second, path);
    expect(existsSync(`${path}.bak`)).toBe(true); // previous version backed up
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).server.port).toBe(
      4100,
    );
    expect(loadConfig(path).config.server.port).toBe(5000);
  });

  it('refuses to write an invalid config', () => {
    const bad = {
      ...defaultConfig(),
      server: { port: -1, host: '127.0.0.1', accessToken: null },
    };
    expect(() => saveConfig(bad as never, path)).toThrow(ConfigError);
    expect(existsSync(path)).toBe(false);
  });
});
