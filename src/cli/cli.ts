/**
 * New aipp CLI shell (epic AIPP-2, subtask 2.6).
 *
 * A small, dependency-light command router. It deliberately imports none of the
 * RelayPlane cloud machinery: there is no startup version-check ping and no
 * signup nudge, and the cloud commands (login, logout, upgrade, telemetry,
 * lifecycle) are removed from the surface. No command performs network egress.
 *
 * The shell is pure and injectable (IO, env, and the legacy runner) so it can be
 * driven in tests without spawning processes or touching the real home dir.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { BIN_NAME, DISPLAY_NAME, PRODUCT_NAME } from '../identity.js';
import {
  configHome,
  configPath,
  loadConfig,
  saveConfig,
  safeStringify,
  redactError,
  secureStateFiles,
  migrateFromRelayplane,
  formatMigrationResult,
} from '../config/index.js';
import {
  TokemetryOutbox,
  exporterHealth,
  formatExporterHealth,
} from '../integrations/tokemetry/index.js';
import { buildProviderRegistry, createGateway } from '../gateway/index.js';
import {
  contentLogDisclosure,
  pruneHistory,
  dataFile,
  DATA_FILES,
  AlertManager,
  ResponseCache,
} from '../ops/index.js';
import type { Config } from '../config/index.js';
import {
  loadPolicyFile,
  policyFilePath,
  replayPolicy,
  type Complexity,
  type ReplayRecord,
} from '../routing/index.js';
import { existsSync, readFileSync } from 'node:fs';

/** Commands available on the new CLI surface. */
export const COMMANDS = [
  'start',
  'config',
  'content-log',
  'tokemetry',
  'policy',
  'alerts',
  'cache',
  'mesh',
  'migrate-from-relayplane',
  'version',
  'help',
] as const;

/** Cloud commands removed from the shipped surface (AIPP-2, decision D-001). */
export const REMOVED_COMMANDS = [
  'login',
  'logout',
  'upgrade',
  'telemetry',
  'lifecycle',
] as const;

/** Output sink; defaults to stdout/stderr. */
export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Injectable dependencies for {@link runCli}. */
export interface CliDeps {
  io?: CliIO;
  /** Runs the legacy proxy for `start --legacy`; injected in tests. */
  runLegacy?: (args: string[]) => Promise<number>;
  /** Config file path override (else resolved from env). */
  configFile?: string;
  /** Opens the Tokemetry outbox; injected in tests. */
  openTokemetryOutbox?: () => TokemetryOutbox;
  /** Boots the gateway for `start`; injected in tests. Resolves when it stops. */
  startGateway?: (io: CliIO, configFile?: string) => Promise<number>;
}

/**
 * On startup, enforce the content-log retention window and (on first run) print
 * the privacy disclosure so operators know content may be stored locally. Both
 * are best-effort and never block startup (epic AIPP-11, subtask 11.6).
 */
export function contentLogStartup(
  io: CliIO,
  config: Config,
  home: string,
  firstRun: boolean,
): void {
  try {
    pruneHistory(dataFile(DATA_FILES.history, home), {
      retentionDays: config.contentLog.retentionDays,
      maxEntries: config.contentLog.maxEntries,
    });
  } catch {
    // retention is best-effort; a prune failure must not stop the gateway
  }
  if (firstRun && config.contentLog.enabled) {
    io.out(
      contentLogDisclosure({
        enabled: config.contentLog.enabled,
        retentionDays: config.contentLog.retentionDays,
        home,
      }),
    );
  }
}

/** Default gateway boot: load config, build the registry, and listen. */
async function defaultStartGateway(
  io: CliIO,
  configFile?: string,
): Promise<number> {
  const path = configFile ?? configPath();
  const firstRun = !existsSync(path);
  const { config, warnings } = loadConfig(configFile);
  for (const w of warnings) {
    io.err(`warning: ${w}`);
  }
  contentLogStartup(io, config, configHome(), firstRun);
  // Restrict every local state file to the owner (best-effort; NFR-SEC-002).
  secureStateFiles(configHome());
  const gateway = createGateway({
    config,
    registry: buildProviderRegistry(),
  });
  const { host, port } = await gateway.listen();
  io.out(`aiproviderproxy gateway listening on http://${host}:${port}`);
  // Resolve only when the process is asked to stop.
  return new Promise<number>((resolve) => {
    const stop = (): void => resolve(0);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function defaultIO(): CliIO {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

function legacyCliPath(): string {
  // Resolves to dist/cli.js when running from the built dist/cli/ directory.
  return join(__dirname, '..', 'cli.js');
}

function defaultRunLegacy(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [legacyCliPath(), 'start', ...args], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
}

function helpText(): string {
  return [
    `${DISPLAY_NAME} (${PRODUCT_NAME}) — ${BIN_NAME}`,
    '',
    'Usage: aipp <command> [options]',
    '',
    'Commands:',
    '  start [--legacy]          Start the gateway (--legacy runs the old proxy)',
    '  config show               Print the effective config with secrets redacted',
    '  content-log on|off|status Toggle or show request/response content logging',
    '  tokemetry status|dlq      Show exporter health or dead-lettered events',
    '  policy replay             Simulate a policy over the routing log',
    '  alerts recent|counts      Show recent alerts or counts by type',
    '  cache stats|clear         Show cache stats or clear the cache',
    '  mesh status|on|off        Toggle the local mesh learning store',
    '  migrate-from-relayplane   Import an existing ~/.relayplane install',
    '  version                   Print the version',
    '  help                      Show this help',
  ].join('\n');
}

function cmdVersion(io: CliIO): number {
  io.out(`${PRODUCT_NAME} ${BIN_NAME}`);
  return 0;
}

async function cmdStart(
  args: string[],
  io: CliIO,
  deps: CliDeps,
): Promise<number> {
  const runLegacy = deps.runLegacy ?? defaultRunLegacy;
  if (args.includes('--legacy')) {
    return runLegacy(args.filter((a) => a !== '--legacy'));
  }
  const start = deps.startGateway ?? defaultStartGateway;
  return start(io, deps.configFile);
}

function cmdConfigShow(io: CliIO, file: string): number {
  try {
    const { config, warnings } = loadConfig(file);
    for (const w of warnings) {
      io.err(`warning: ${w}`);
    }
    io.out(safeStringify(config));
    return 0;
  } catch (err) {
    io.err(`error: ${redactError(err)}`);
    return 1;
  }
}

function cmdContentLog(args: string[], io: CliIO, file: string): number {
  const sub = args[0];
  if (sub !== 'on' && sub !== 'off' && sub !== 'status') {
    io.err('usage: aipp content-log on|off|status');
    return 2;
  }
  try {
    const { config } = loadConfig(file);
    if (sub === 'status') {
      io.out(`content logging is ${config.contentLog.enabled ? 'on' : 'off'}`);
      io.out(
        contentLogDisclosure({
          enabled: config.contentLog.enabled,
          retentionDays: config.contentLog.retentionDays,
          home: configHome(),
        }),
      );
      return 0;
    }
    config.contentLog.enabled = sub === 'on';
    saveConfig(config, file);
    io.out(`content logging is now ${sub}`);
    return 0;
  } catch (err) {
    io.err(`error: ${redactError(err)}`);
    return 1;
  }
}

function cmdTokemetry(args: string[], io: CliIO, deps: CliDeps): number {
  const sub = args[0];
  if (sub !== 'status' && sub !== 'dlq') {
    io.err('usage: aipp tokemetry status|dlq');
    return 2;
  }
  const outbox =
    deps.openTokemetryOutbox?.() ??
    new TokemetryOutbox({ path: join(configHome(), 'tokemetry-outbox.db') });
  try {
    if (sub === 'status') {
      io.out(formatExporterHealth(exporterHealth(outbox)));
    } else {
      const dead = outbox.deadLetters();
      io.out(`${dead.length} dead-lettered event(s)`);
      for (const row of dead.slice(0, 50)) {
        io.out(`  ${row.event_id}  ${row.last_error ?? ''}`);
      }
    }
    return 0;
  } catch (err) {
    io.err(`error: ${redactError(err)}`);
    return 1;
  } finally {
    if (!deps.openTokemetryOutbox) {
      outbox.close();
    }
  }
}

/** Value of a `--flag value` option in an argv slice. */
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const COMPLEXITIES: readonly Complexity[] = ['simple', 'moderate', 'complex'];

/** Map an untyped routing-log v2 line to a replay record (lenient defaults). */
function toReplayRecord(rec: Record<string, unknown>): ReplayRecord {
  const complexity = rec.complexity;
  const candidate =
    typeof rec.routedModel === 'string'
      ? rec.routedModel
      : typeof rec.candidateModel === 'string'
        ? rec.candidateModel
        : '';
  return {
    agentName: typeof rec.agentName === 'string' ? rec.agentName : undefined,
    agentFingerprint:
      typeof rec.agentFingerprint === 'string'
        ? rec.agentFingerprint
        : undefined,
    taskType: typeof rec.taskType === 'string' ? rec.taskType : 'general',
    complexity: COMPLEXITIES.includes(complexity as Complexity)
      ? (complexity as Complexity)
      : 'moderate',
    candidateModel: candidate,
  };
}

/**
 * `aipp policy replay` -- simulate a policy over the routing-log v2 records
 * and report which routed models it would have changed. Reads only local files;
 * no network egress and no writes.
 */
function cmdPolicy(args: string[], io: CliIO): number {
  if (args[0] !== 'replay') {
    io.err('usage: aipp policy replay [--policy <file>] [--log <file>]');
    return 2;
  }
  const policyPath = flagValue(args, '--policy') ?? policyFilePath();
  const logPath = flagValue(args, '--log') ?? dataFile(DATA_FILES.routingLog);

  const policy = loadPolicyFile(policyPath);
  if (!policy) {
    io.err(
      `no valid policy at ${policyPath} (missing, unparseable, or wrong version)`,
    );
    return 1;
  }
  if (!existsSync(logPath)) {
    io.err(`no routing log at ${logPath}`);
    return 1;
  }

  const records: ReplayRecord[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(
        toReplayRecord(JSON.parse(trimmed) as Record<string, unknown>),
      );
    } catch {
      // skip a malformed line rather than aborting the whole replay
    }
  }

  const summary = replayPolicy(records, policy);
  io.out(
    `replayed ${summary.total} record(s): ${summary.changed} changed, ${summary.unchanged} unchanged`,
  );
  for (const change of summary.changes) {
    io.out(`  ${change.from} -> ${change.to}  (${change.resolvedBy})`);
  }
  return 0;
}

/**
 * `aipp alerts recent|counts` -- read-only view of the local alert history. It
 * never delivers webhooks or performs any network egress.
 */
function cmdAlerts(args: string[], io: CliIO, file: string): number {
  const sub = args[0];
  if (sub !== 'recent' && sub !== 'counts') {
    io.err('usage: aipp alerts recent|counts');
    return 2;
  }
  try {
    const { config } = loadConfig(file);
    const manager = new AlertManager({
      enabled: config.alerts.enabled,
      cooldownMs: config.alerts.cooldownMs,
      maxHistory: config.alerts.maxHistory,
    });
    try {
      if (sub === 'counts') {
        const counts = manager.getCounts();
        io.out(
          `threshold: ${counts.threshold}  anomaly: ${counts.anomaly}  breach: ${counts.breach}`,
        );
      } else {
        const recent = manager.getRecent(20);
        if (recent.length === 0) {
          io.out('no alerts recorded');
        }
        for (const a of recent) {
          io.out(`[${a.severity}] ${a.type}: ${a.message}`);
        }
      }
      return 0;
    } finally {
      manager.close();
    }
  } catch (err) {
    io.err(`error: ${redactError(err)}`);
    return 1;
  }
}

/**
 * `aipp cache stats|clear` -- inspect or clear the local response cache. No
 * network egress.
 */
function cmdCache(args: string[], io: CliIO, file: string): number {
  const sub = args[0];
  if (sub !== 'stats' && sub !== 'clear') {
    io.err('usage: aipp cache stats|clear');
    return 2;
  }
  try {
    const { config } = loadConfig(file);
    const cache = new ResponseCache({
      enabled: config.cache.enabled,
      maxSizeMb: config.cache.maxSizeMb,
      defaultTtlSeconds: config.cache.defaultTtlSeconds,
      onlyWhenDeterministic: config.cache.onlyWhenDeterministic,
    });
    try {
      if (sub === 'clear') {
        cache.clear();
        io.out('cache cleared');
      } else {
        const stats = cache.getStats();
        io.out(
          `entries: ${stats.entries}  size: ${(stats.sizeBytes / 1_000_000).toFixed(2)} MB  ` +
            `hits: ${stats.hits}  misses: ${stats.misses}`,
        );
      }
      return 0;
    } finally {
      cache.close();
    }
  } catch (err) {
    io.err(`error: ${redactError(err)}`);
    return 1;
  }
}

/**
 * `aipp mesh status|on|off` -- toggle the LOCAL mesh learning store. The legacy
 * sync/contribute commands are gone with the remote-sync deletion; this command
 * only edits local config and performs no network egress.
 */
function cmdMesh(args: string[], io: CliIO, file: string): number {
  const sub = args[0];
  if (sub !== 'status' && sub !== 'on' && sub !== 'off') {
    io.err('usage: aipp mesh status|on|off');
    return 2;
  }
  try {
    const { config } = loadConfig(file);
    if (sub === 'status') {
      io.out(`mesh is ${config.mesh.enabled ? 'on' : 'off'} (local-only)`);
      return 0;
    }
    config.mesh.enabled = sub === 'on';
    saveConfig(config, file);
    io.out(`mesh is now ${sub}`);
    return 0;
  } catch (err) {
    io.err(`error: ${redactError(err)}`);
    return 1;
  }
}

function cmdMigrate(args: string[], io: CliIO): number {
  try {
    const result = migrateFromRelayplane({ force: args.includes('--force') });
    io.out(formatMigrationResult(result));
    return 0;
  } catch (err) {
    io.err(`error: ${redactError(err)}`);
    return 1;
  }
}

/**
 * Run the CLI. Returns a process exit code; never throws for ordinary command
 * errors (they are printed and mapped to a non-zero code).
 */
export async function runCli(
  argv: string[],
  deps: CliDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIO();
  const file = deps.configFile ?? configPath();

  const [command, ...args] = argv;

  if (
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    io.out(helpText());
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    return cmdVersion(io);
  }
  if ((REMOVED_COMMANDS as readonly string[]).includes(command)) {
    io.err(
      `"${command}" was removed: aiproviderproxy has no cloud account, ` +
        'telemetry, or auto-update. See docs/migration.md.',
    );
    return 2;
  }
  switch (command) {
    case 'start':
      return cmdStart(args, io, deps);
    case 'config':
      if (args[0] === 'show') {
        return cmdConfigShow(io, file);
      }
      io.err('usage: aipp config show');
      return 2;
    case 'content-log':
      return cmdContentLog(args, io, file);
    case 'tokemetry':
      return cmdTokemetry(args, io, deps);
    case 'policy':
      return cmdPolicy(args, io);
    case 'alerts':
      return cmdAlerts(args, io, file);
    case 'cache':
      return cmdCache(args, io, file);
    case 'mesh':
      return cmdMesh(args, io, file);
    case 'migrate-from-relayplane':
      return cmdMigrate(args, io);
    default:
      io.err(`unknown command "${command}". Run "aipp help".`);
      return 2;
  }
}
