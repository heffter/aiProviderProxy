/**
 * Unit tests for the migrate-from-relayplane importer (epic AIPP-2, subtask 2.5).
 *
 * Uses a representative captured v4 config plus data files in a temp source
 * home, and asserts the mapping, file copy, marker, and idempotency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatMigrationResult,
  mapV4ToV1,
  migrateFromRelayplane,
  MIGRATION_MARKER,
} from '../../src/config/migrate-relayplane.js';
import { loadConfig } from '../../src/config/loader.js';

// A representative legacy v4 config (superset of config.ts + standalone-proxy schemas).
const V4_CONFIG = {
  config_version: 4,
  device_id: 'dev-123',
  telemetry_enabled: true,
  api_key: 'rp_live_example',
  providers: {
    anthropic: { rateLimit: { rpm: 100 }, label: 'Anthropic' },
    openai: { enabled: false },
  },
  ollama: { baseUrl: 'http://localhost:11434', models: ['llama3.1'] },
  modelOverrides: { fast: 'claude-3-5-haiku' },
  mode: 'cascade',
  routing: { mode: 'complexity' },
  cache: { enabled: false },
  budget: { enabled: true, dailyUsd: 5 },
  alerts: { enabled: true },
  dashboard: { showRequestContent: false },
  crossProviderCascade: { enabled: true, triggerStatuses: [429, 503] },
  rateLimit: { rpm: 600 },
  traces: { enabled: true, retentionDays: 30 },
};

let sourceHome: string;
let targetHome: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'aipp-migrate-'));
  sourceHome = join(base, '.relayplane');
  targetHome = join(base, '.aiproviderproxy');
  mkdirSync(sourceHome, { recursive: true });
});

afterEach(() => {
  rmSync(join(sourceHome, '..'), { recursive: true, force: true });
});

describe('mapV4ToV1', () => {
  it('maps the documented legacy fields to schema v1', () => {
    const { config, warnings } = mapV4ToV1(V4_CONFIG);
    expect(config.routing.mode).toBe('complexity'); // routing.mode wins over top-level mode
    expect(config.cache.enabled).toBe(false);
    expect(config.budget).toMatchObject({ enabled: true, dailyUsd: 5 });
    expect(config.contentLog.enabled).toBe(false); // dashboard.showRequestContent:false
    expect(config.routing.crossProviderCascade).toMatchObject({
      enabled: true,
      triggerStatuses: [429, 503],
    });
    expect(config.models.overrides).toEqual({ fast: 'claude-3-5-haiku' });
    expect(config.providers.openai).toMatchObject({ enabled: false });
    expect(config.providers.ollama).toMatchObject({
      enabled: true,
      baseUrl: 'http://localhost:11434',
    });
    // unmodelled + telemetry warnings
    expect(warnings.some((w) => w.includes('rateLimit'))).toBe(true);
    expect(warnings.some((w) => w.includes('telemetry'))).toBe(true);
  });

  it('defaults content logging on when dashboard is absent', () => {
    expect(mapV4ToV1({}).config.contentLog.enabled).toBe(true);
  });

  it('warns and falls back on an unrecognised routing mode', () => {
    const { config, warnings } = mapV4ToV1({ mode: 'bogus' });
    expect(config.routing.mode).toBe('standard');
    expect(warnings.some((w) => w.includes('bogus'))).toBe(true);
  });
});

describe('migrateFromRelayplane', () => {
  function seedSource(): void {
    writeFileSync(
      join(sourceHome, 'config.json'),
      JSON.stringify(V4_CONFIG),
      'utf8',
    );
    writeFileSync(join(sourceHome, 'history.jsonl'), '{"id":1}\n', 'utf8');
    writeFileSync(join(sourceHome, 'agents.json'), '{}', 'utf8');
    mkdirSync(join(sourceHome, 'traces'), { recursive: true });
    writeFileSync(join(sourceHome, 'traces', 'index.db'), 'x', 'utf8');
  }

  it('migrates config and data files and writes a marker', () => {
    seedSource();
    const result = migrateFromRelayplane({
      relayplaneHome: sourceHome,
      targetHome,
    });

    expect(result.alreadyMigrated).toBe(false);
    expect(existsSync(join(targetHome, 'config.json'))).toBe(true);
    expect(result.copiedFiles).toEqual(
      expect.arrayContaining(['history.jsonl', 'agents.json', 'traces/']),
    );
    expect(existsSync(join(targetHome, 'history.jsonl'))).toBe(true);
    expect(existsSync(join(targetHome, 'traces', 'index.db'))).toBe(true);
    expect(existsSync(join(targetHome, MIGRATION_MARKER))).toBe(true);

    // migrated config is valid v1 and reflects the mapping
    expect(
      loadConfig(join(targetHome, 'config.json')).config.routing.mode,
    ).toBe('complexity');

    // source is left untouched
    expect(existsSync(join(sourceHome, 'config.json'))).toBe(true);
    expect(existsSync(join(sourceHome, 'history.jsonl'))).toBe(true);
  });

  it('is idempotent: a second run is a no-op', () => {
    seedSource();
    migrateFromRelayplane({ relayplaneHome: sourceHome, targetHome });
    const markerBefore = readFileSync(
      join(targetHome, MIGRATION_MARKER),
      'utf8',
    );

    const second = migrateFromRelayplane({
      relayplaneHome: sourceHome,
      targetHome,
    });
    expect(second.alreadyMigrated).toBe(true);
    expect(second.copiedFiles).toEqual([]);
    // marker unchanged
    expect(readFileSync(join(targetHome, MIGRATION_MARKER), 'utf8')).toBe(
      markerBefore,
    );
  });

  it('re-runs with force and backs up the prior config', () => {
    seedSource();
    migrateFromRelayplane({ relayplaneHome: sourceHome, targetHome });
    const forced = migrateFromRelayplane({
      relayplaneHome: sourceHome,
      targetHome,
      force: true,
    });
    expect(forced.alreadyMigrated).toBe(false);
    expect(existsSync(join(targetHome, 'config.json.bak'))).toBe(true);
  });

  it('warns but still writes defaults when no source config exists', () => {
    const result = migrateFromRelayplane({
      relayplaneHome: sourceHome,
      targetHome,
    });
    expect(
      result.warnings.some((w) => w.includes('No RelayPlane config')),
    ).toBe(true);
    expect(existsSync(join(targetHome, 'config.json'))).toBe(true);
  });

  it('formats a result for CLI output (both migrated and no-op)', () => {
    seedSource();
    const first = migrateFromRelayplane({
      relayplaneHome: sourceHome,
      targetHome,
    });
    const firstText = formatMigrationResult(first);
    expect(firstText).toContain('Migrated RelayPlane config');
    expect(firstText).toContain('rollback');

    const second = migrateFromRelayplane({
      relayplaneHome: sourceHome,
      targetHome,
    });
    expect(formatMigrationResult(second)).toContain('Already migrated');
  });
});
