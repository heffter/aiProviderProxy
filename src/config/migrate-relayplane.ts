/**
 * migrate-from-relayplane importer (epic AIPP-2, subtask 2.5; FR-CONFIG-002, FR-IDENT-003).
 *
 * Reads a legacy `~/.relayplane/config.json` (schema v4 -- a superset of the
 * config.ts and standalone-proxy local schemas), maps it to config schema v1,
 * and copies the legacy data files into `~/.aiproviderproxy`. The source
 * `~/.relayplane` tree is never modified, so rollback is simply "keep using the
 * old install" (see docs/migration.md).
 *
 * Idempotent: a marker file records the migration; a second run is a no-op
 * unless `force` is set. The target config write goes through the loader's
 * atomic write + backup.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configHome, saveConfig } from './loader.js';
import { configSchema, ROUTING_MODES, type Config } from './schema.js';

/** Legacy data files copied verbatim into the new home. */
const DATA_FILES = [
  'history.jsonl',
  'routing-log.jsonl',
  'agents.json',
  'sessions.db',
  'budget.db',
  'alerts.db',
  'osmosis.db',
  'mesh.db',
];

/** Legacy data directories copied recursively into the new home. */
const DATA_DIRS = ['traces', 'cache'];

/** Marker file recording that a migration has run. */
export const MIGRATION_MARKER = '.migrated-from-relayplane.json';

/** Thrown when the legacy config cannot be mapped to a valid v1 config. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrateOptions {
  /** Source `.relayplane` home; defaults to {@link relayplaneHomeDefault}. */
  relayplaneHome?: string;
  /** Target home; defaults to the aipp config home. */
  targetHome?: string;
  /** Re-run even if the migration marker is present. */
  force?: boolean;
}

export interface MigrationResult {
  alreadyMigrated: boolean;
  configPath: string;
  copiedFiles: string[];
  warnings: string[];
  sourceHome: string;
  targetHome: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** The default legacy home (`RELAYPLANE_HOME_OVERRIDE` or `~/.relayplane`). */
export function relayplaneHomeDefault(): string {
  const override = process.env.RELAYPLANE_HOME_OVERRIDE;
  return override
    ? join(override, '.relayplane')
    : join(homedir(), '.relayplane');
}

/**
 * Map a legacy v4 config object to a validated v1 {@link Config}. Unmodelled
 * legacy sections (rateLimit, traces) are preserved via passthrough with a
 * warning; RelayPlane cloud telemetry is intentionally not migrated (D-001).
 */
export function mapV4ToV1(v4: Record<string, unknown>): {
  config: Config;
  warnings: string[];
} {
  const warnings: string[] = [];
  const routing = asObject(v4.routing);
  const dashboard = asObject(v4.dashboard);
  const cache = asObject(v4.cache);
  const budget = asObject(v4.budget);
  const alerts = asObject(v4.alerts);
  const anomaly = asObject(v4.anomaly);
  const mesh = asObject(v4.mesh);
  const crossCascade = asObject(v4.crossProviderCascade);

  let mode = (routing.mode ?? v4.mode) as string | undefined;
  if (
    mode !== undefined &&
    !(ROUTING_MODES as readonly string[]).includes(mode)
  ) {
    warnings.push(
      `Legacy routing mode "${mode}" is not recognised; defaulting to "standard".`,
    );
    mode = undefined;
  }

  const providersOut: Record<string, unknown> = {};
  const v4providers = asObject(v4.providers);
  for (const name of Object.keys(v4providers)) {
    const p = asObject(v4providers[name]);
    providersOut[name] = {
      enabled: asBool(p.enabled) ?? true,
      ...(typeof p.baseUrl === 'string' ? { baseUrl: p.baseUrl } : {}),
    };
  }
  const ollama = asObject(v4.ollama);
  if (Object.keys(ollama).length > 0) {
    providersOut.ollama = {
      enabled: true,
      ...(typeof ollama.baseUrl === 'string'
        ? { baseUrl: ollama.baseUrl }
        : {}),
    };
  }

  // Content logging default-on unless the legacy dashboard explicitly disabled it.
  const contentLogEnabled = dashboard.showRequestContent !== false;

  const v1: Record<string, unknown> = {
    version: 1,
    providers: providersOut,
    models: { overrides: asObject(v4.modelOverrides) },
    routing: {
      ...(mode ? { mode } : {}),
      crossProviderCascade: {
        enabled: asBool(crossCascade.enabled) ?? false,
        ...(Array.isArray(crossCascade.triggerStatuses)
          ? { triggerStatuses: crossCascade.triggerStatuses }
          : {}),
      },
    },
    cache: { enabled: asBool(cache.enabled) ?? true },
    budget: {
      enabled: asBool(budget.enabled) ?? false,
      ...(typeof budget.dailyUsd === 'number'
        ? { dailyUsd: budget.dailyUsd }
        : {}),
    },
    alerts: { enabled: asBool(alerts.enabled) ?? false },
    anomaly: { enabled: asBool(anomaly.enabled) ?? false },
    contentLog: { enabled: contentLogEnabled },
    mesh: { enabled: asBool(mesh.enabled) ?? false },
  };

  for (const key of ['rateLimit', 'traces']) {
    if (v4[key] !== undefined) {
      v1[key] = v4[key];
      warnings.push(
        `Legacy "${key}" preserved but not yet modelled in config v1.`,
      );
    }
  }
  if (v4.telemetry_enabled === true || typeof v4.api_key === 'string') {
    warnings.push(
      'RelayPlane cloud telemetry / api_key are not migrated (cloud integration removed, D-001).',
    );
  }

  const parsed = configSchema.safeParse(v1);
  if (!parsed.success) {
    throw new MigrationError(
      `Mapped configuration failed validation:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return { config: parsed.data, warnings };
}

/**
 * Perform the migration. Idempotent: a no-op when the marker already exists
 * (unless `force`). Never modifies the source `.relayplane` tree.
 */
export function migrateFromRelayplane(
  opts: MigrateOptions = {},
): MigrationResult {
  const sourceHome = opts.relayplaneHome ?? relayplaneHomeDefault();
  const targetHome = opts.targetHome ?? configHome();
  const markerPath = join(targetHome, MIGRATION_MARKER);
  const configPath = join(targetHome, 'config.json');
  const warnings: string[] = [];

  if (existsSync(markerPath) && !opts.force) {
    return {
      alreadyMigrated: true,
      configPath,
      copiedFiles: [],
      warnings: [
        `Already migrated (marker at ${markerPath}); pass force to re-run.`,
      ],
      sourceHome,
      targetHome,
    };
  }

  mkdirSync(targetHome, { recursive: true });

  let v4: Record<string, unknown> = {};
  const sourceConfig = join(sourceHome, 'config.json');
  if (existsSync(sourceConfig)) {
    try {
      v4 = asObject(JSON.parse(readFileSync(sourceConfig, 'utf8')));
    } catch {
      warnings.push(
        `Source config at ${sourceConfig} is not valid JSON; migrating defaults.`,
      );
    }
  } else {
    warnings.push(
      `No RelayPlane config at ${sourceConfig}; writing a default config.`,
    );
  }

  const mapped = mapV4ToV1(v4);
  warnings.push(...mapped.warnings);
  saveConfig(mapped.config, configPath);

  const copiedFiles: string[] = [];
  for (const file of DATA_FILES) {
    const src = join(sourceHome, file);
    if (existsSync(src)) {
      copyFileSync(src, join(targetHome, file));
      copiedFiles.push(file);
    }
  }
  for (const dir of DATA_DIRS) {
    const src = join(sourceHome, dir);
    if (existsSync(src)) {
      cpSync(src, join(targetHome, dir), { recursive: true });
      copiedFiles.push(`${dir}/`);
    }
  }

  writeFileSync(
    markerPath,
    `${JSON.stringify(
      { migratedAt: new Date().toISOString(), source: sourceHome, copiedFiles },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    alreadyMigrated: false,
    configPath,
    copiedFiles,
    warnings,
    sourceHome,
    targetHome,
  };
}

/** Render a migration result for CLI output. */
export function formatMigrationResult(result: MigrationResult): string {
  if (result.alreadyMigrated) {
    return `Already migrated. ${result.warnings.join(' ')}`;
  }
  const lines = [
    `Migrated RelayPlane config to ${result.configPath}.`,
    result.copiedFiles.length
      ? `Copied: ${result.copiedFiles.join(', ')}.`
      : 'No legacy data files found to copy.',
    `Source left untouched at ${result.sourceHome} (rollback: keep using the old install).`,
  ];
  for (const w of result.warnings) {
    lines.push(`- ${w}`);
  }
  return lines.join('\n');
}
