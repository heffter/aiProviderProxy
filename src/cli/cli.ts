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
  migrateFromRelayplane,
  formatMigrationResult,
} from '../config/index.js';
import {
  TokemetryOutbox,
  exporterHealth,
  formatExporterHealth,
} from '../integrations/tokemetry/index.js';
import { buildProviderRegistry, createGateway } from '../gateway/index.js';

/** Commands available on the new CLI surface. */
export const COMMANDS = [
  'start',
  'config',
  'content-log',
  'tokemetry',
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

/** Default gateway boot: load config, build the registry, and listen. */
async function defaultStartGateway(
  io: CliIO,
  configFile?: string,
): Promise<number> {
  const { config, warnings } = loadConfig(configFile);
  for (const w of warnings) {
    io.err(`warning: ${w}`);
  }
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
    case 'migrate-from-relayplane':
      return cmdMigrate(args, io);
    default:
      io.err(`unknown command "${command}". Run "aipp help".`);
      return 2;
  }
}
