/**
 * Single configuration loader (epic AIPP-2, subtask 2.3).
 *
 * Replaces the four legacy config surfaces with one load/save path:
 * - zod validation with actionable startup errors (FR-CONFIG-001)
 * - unknown keys preserved and reported as warnings (FR-CONFIG-003)
 * - env overrides for non-secret settings (FR-CONFIG-005)
 * - atomic writes with backup, ported from the legacy behaviour (FR-CONFIG-008)
 * - corrupt-file fallback to defaults rather than a crash
 * - refuses to start on a non-loopback host without an access token (FR-AUTH-012)
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOME_DIR_NAME } from '../identity.js';
import {
  configSchema,
  KNOWN_TOP_LEVEL_KEYS,
  ROUTING_MODES,
  type Config,
  type RoutingMode,
} from './schema.js';

/** Hosts treated as loopback (no access token required). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Thrown for invalid configuration; message is user-actionable. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Result of loading configuration. */
export interface LoadResult {
  config: Config;
  warnings: string[];
  path: string;
}

/** The config home directory (`AIPP_HOME` or `~/.aiproviderproxy`). */
export function configHome(): string {
  return process.env.AIPP_HOME || join(homedir(), HOME_DIR_NAME);
}

/** The config file path (`AIPP_CONFIG_PATH` or `<home>/config.json`). */
export function configPath(): string {
  return process.env.AIPP_CONFIG_PATH || join(configHome(), 'config.json');
}

/** True if `host` is a loopback address that needs no access token. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function formatIssues(error: import('zod').ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

function applyEnvOverrides(config: Config, warnings: string[]): void {
  const envPort = process.env.AIPP_PORT;
  if (envPort !== undefined) {
    const n = Number(envPort);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) {
      config.server.port = n;
    } else {
      warnings.push(`AIPP_PORT="${envPort}" is not a valid port; ignored.`);
    }
  }

  const envHost = process.env.AIPP_HOST;
  if (envHost) {
    config.server.host = envHost;
  }

  const envMode = process.env.AIPP_ROUTING_MODE;
  if (envMode) {
    if ((ROUTING_MODES as readonly string[]).includes(envMode)) {
      config.routing.mode = envMode as RoutingMode;
    } else {
      warnings.push(
        `AIPP_ROUTING_MODE="${envMode}" is not a valid mode; ignored.`,
      );
    }
  }
}

/**
 * Load and validate configuration.
 *
 * @throws {ConfigError} on schema-invalid config or an unsafe host/token
 *   combination. A corrupt (unparseable) file is NOT fatal: it falls back to
 *   defaults with a warning.
 */
export function loadConfig(path: string = configPath()): LoadResult {
  const warnings: string[] = [];
  let raw: unknown = {};

  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    try {
      raw = JSON.parse(text);
    } catch {
      warnings.push(
        `Config at ${path} is not valid JSON; falling back to defaults.`,
      );
      raw = {};
    }
  }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(raw)) {
      if (!KNOWN_TOP_LEVEL_KEYS.includes(key)) {
        warnings.push(`Unknown config key "${key}" preserved but not used.`);
      }
    }
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration at ${path}:\n${formatIssues(parsed.error)}`,
    );
  }
  const config = parsed.data;

  applyEnvOverrides(config, warnings);

  if (!isLoopbackHost(config.server.host) && !config.server.accessToken) {
    throw new ConfigError(
      `server.host "${config.server.host}" is not loopback but server.accessToken ` +
        `is not set. Set an access token or bind 127.0.0.1 (FR-AUTH-012).`,
    );
  }

  return { config, warnings, path };
}

/**
 * Validate and persist configuration with an atomic write and a backup of the
 * previous file (ported from the legacy loader). The prior file is copied to
 * `<path>.bak`, the new content is written to `<path>.tmp`, then renamed into
 * place so a crash never leaves a partially written config.
 *
 * @throws {ConfigError} if `config` fails schema validation.
 */
export function saveConfig(config: Config, path: string = configPath()): void {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new ConfigError(
      `Refusing to save invalid configuration:\n${formatIssues(parsed.error)}`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
    } catch {
      // best-effort backup, matching legacy behaviour
    }
  }

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
