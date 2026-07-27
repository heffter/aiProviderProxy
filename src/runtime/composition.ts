/**
 * Runtime composition root (Task 15).
 *
 * `createGateway` accepts every subsystem as an OPTIONAL injected dependency and
 * builds none of them; the `aipp start` path historically passed only
 * `{ config, registry }`, so it ran a bare routing proxy: nothing wrote
 * `history.jsonl` (empty dashboard), budget/anomaly/alerts/mesh captured
 * nothing, and no Tokemetry export loop ran even when enabled. Every subsystem
 * was built, unit-tested, and injectable via {@link GatewayDeps} -- but the
 * composition root that assembles them from config and owns their lifecycle was
 * never written.
 *
 * This module is that root. {@link createGatewayRuntime} constructs the
 * {@link EventSinkRegistry} and registers the observability trackers plus the
 * config-gated subsystem sinks, builds the Tokemetry outbox and a batcher export
 * pump, constructs the budget/cache/mesh managers, and passes them all into
 * {@link createGateway}. The returned {@link GatewayRuntime} owns an orderly
 * shutdown: stop listening, stop the export pump, drain the sinks, flush and
 * close the outbox, and close every SQLite-backed component.
 *
 * Without this root the AIPP-5 (Tokemetry export) and AIPP-11 (ported
 * subsystems) features do not run in production.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  configHome,
  type Config,
  type CredentialRef,
} from '../config/index.js';
import { PRODUCT_NAME, PRODUCT_VERSION } from '../identity.js';
import { createGateway, type Gateway } from '../gateway/server.js';
import { buildProviderRegistry } from '../gateway/providers.js';
import { httpTransport } from '../gateway/transport.js';
import type { Transport } from '../providers/types.js';
import { EventSinkRegistry } from '../lifecycle/event-sinks.js';
import {
  HistorySink,
  AgentsSink,
  SessionsSink,
  TracesSink,
  RoutingLogSink,
  BudgetManager,
  BudgetSink,
  ResponseCache,
  MeshStore,
  MeshSink,
  AnomalyDetector,
  AlertManager,
  AnomalyAlertSink,
} from '../ops/index.js';
import {
  TokemetryOutbox,
  TokemetryBatcher,
} from '../integrations/tokemetry/index.js';

/** Default cadence of the Tokemetry export pump. */
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/** Path (under the base URL) of the Tokemetry v2 ingest endpoint. */
const INGEST_PATH = '/api/v2/ingest/events';

/** Options for {@link createGatewayRuntime}. */
export interface RuntimeOptions {
  /** State/config home; defaults to {@link configHome}. All DBs live here. */
  home?: string;
  /**
   * Provider transport, shared by the gateway and the Tokemetry batcher.
   * Defaults to {@link httpTransport}; tests inject a fake.
   */
  transport?: Transport;
  /** Export-pump cadence in ms (default 5000). Ignored when Tokemetry is off. */
  flushIntervalMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Warning sink for misconfiguration; defaults to stderr. */
  warn?: (message: string) => void;
}

/** A composed, lifecycle-owning gateway ready to serve and shut down cleanly. */
export interface GatewayRuntime {
  /** The composed gateway. */
  readonly gateway: Gateway;
  /** The sink registry, exposed for tests and introspection. */
  readonly sinks: EventSinkRegistry;
  /** The Tokemetry outbox when export is enabled, else undefined. */
  readonly outbox?: TokemetryOutbox;
  /** Bind the HTTP listener. Resolves with the bound host/port. */
  listen(): Promise<{ host: string; port: number }>;
  /**
   * Orderly shutdown: stop the listener and export pump, drain the sinks, flush
   * and close the outbox, and close every SQLite-backed component. Idempotent.
   */
  stop(): Promise<void>;
}

/**
 * Resolve a {@link CredentialRef} (env var or file) to its secret string.
 * Returns undefined when the ref is absent or resolves to an empty value.
 */
export function resolveCredential(
  ref: CredentialRef | undefined,
): string | undefined {
  if (!ref) {
    return undefined;
  }
  if (ref.type === 'env') {
    const value = process.env[ref.name];
    return value && value.length > 0 ? value : undefined;
  }
  // type === 'file'
  const value = readFileSync(ref.path, 'utf8').trim();
  return value.length > 0 ? value : undefined;
}

/** Join a base URL and a path without doubling or dropping the separator. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Build a fully wired gateway runtime from config.
 *
 * Driven by config flags, this constructs the sink registry (history + agents +
 * sessions + traces + routing-log always on; budget/anomaly-alert/mesh sinks
 * gated by their `enabled` flags), the Tokemetry outbox and export pump (when
 * `integrations.tokemetry.enabled`), and the budget/cache/mesh managers, then
 * injects them into {@link createGateway}. Nothing binds a socket until
 * {@link GatewayRuntime.listen} is called.
 */
export function createGatewayRuntime(
  config: Config,
  options: RuntimeOptions = {},
): GatewayRuntime {
  const home = options.home ?? configHome();
  const transport = options.transport ?? httpTransport;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  // Components that hold a SQLite handle and must be closed on shutdown.
  const closables: Array<{ close(): void }> = [];

  // --- Event sink registry: observability trackers (always on) ---------------
  const sinks = new EventSinkRegistry();
  sinks.register(
    new HistorySink({
      dir: home,
      contentLogEnabled: config.contentLog.enabled,
      // No content buffer exists to feed getContent yet; history is written
      // metadata-only, which is what the dashboard reads. Prompt/response
      // capture is a separate, deferred concern (see Task 16).
    }),
  );
  sinks.register(new AgentsSink({ dir: home }));

  const sessionsSink = new SessionsSink({ dir: home });
  closables.push(sessionsSink);
  sinks.register(sessionsSink);

  const tracesSink = new TracesSink({ dir: home });
  closables.push(tracesSink);
  sinks.register(tracesSink);

  sinks.register(new RoutingLogSink({ dir: home }));

  // --- Budget: manager + gate + spend sink (config-gated) --------------------
  let budget: BudgetManager | undefined;
  if (config.budget.enabled) {
    budget = new BudgetManager(config.budget, { dir: home, now });
    closables.push(budget);
    sinks.register(new BudgetSink(budget));
  }

  // --- Anomaly detection + alerting (both flags required) --------------------
  if (config.anomaly.enabled && config.alerts.enabled) {
    const detector = new AnomalyDetector(config.anomaly, { now });
    const alerts = new AlertManager(config.alerts, { dir: home, now });
    closables.push(alerts);
    sinks.register(new AnomalyAlertSink(detector, alerts));
  }

  // --- Mesh: episodic memory store + capture sink (config-gated) -------------
  let mesh: MeshStore | undefined;
  if (config.mesh.enabled) {
    mesh = new MeshStore({ dir: home, now });
    closables.push(mesh);
    sinks.register(new MeshSink(mesh));
  }

  // --- Response cache (config-gated) -----------------------------------------
  let cache: ResponseCache | undefined;
  if (config.cache.enabled) {
    cache = new ResponseCache(config.cache, { dir: home, now });
    closables.push(cache);
  }

  // --- Tokemetry durable export: outbox + batcher pump (config-gated) --------
  let outbox: TokemetryOutbox | undefined;
  let pump: ReturnType<typeof setInterval> | undefined;
  let batcher: TokemetryBatcher | undefined;
  if (config.integrations.tokemetry.enabled) {
    const tk = config.integrations.tokemetry;
    outbox = new TokemetryOutbox({
      path: tk.queuePath ?? join(home, 'tokemetry-outbox.db'),
    });
    closables.push(outbox);

    const token = resolveCredential(tk.credential);
    if (!tk.baseUrl || !token) {
      // Enabled but not fully configured: events still accrue durably in the
      // outbox (visible via `aipp tokemetry status`), but nothing exports until
      // baseUrl and a resolvable credential are present.
      warn(
        'tokemetry: export enabled but baseUrl or credential is missing; ' +
          'events will queue in the outbox but not be exported',
      );
    } else {
      batcher = new TokemetryBatcher(
        {
          endpoint: joinUrl(tk.baseUrl, INGEST_PATH),
          token,
          batchSize: tk.batchMaxEvents,
          mapperConfig: {
            machine: tk.machine,
            project: { mode: tk.project.mode, value: tk.project.value },
            proxyVersion: PRODUCT_VERSION,
            sourceName: PRODUCT_NAME,
          },
        },
        { outbox, transport, now },
      );
      const intervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
      let flushing = false;
      pump = setInterval(() => {
        // Guard against overlapping flushes if one exceeds the interval.
        if (flushing) {
          return;
        }
        flushing = true;
        void Promise.resolve(batcher!.flushOnce())
          .catch((err: unknown) => {
            warn(`tokemetry: export flush failed: ${String(err)}`);
          })
          .finally(() => {
            flushing = false;
          });
      }, intervalMs);
      // Do not let the pump keep the process alive on its own.
      pump.unref?.();
    }
  }

  // --- Compose the gateway ---------------------------------------------------
  const gateway = createGateway({
    config,
    registry: buildProviderRegistry(),
    transport,
    sinks,
    outbox,
    budget,
    cache,
    mesh,
    dataDir: home,
  });

  let stopped = false;
  const runtime: GatewayRuntime = {
    gateway,
    sinks,
    outbox,
    async listen() {
      return gateway.listen();
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      // 1. Stop accepting new work.
      gateway.close();
      // 2. Stop the export pump so no new flush starts during teardown.
      if (pump) {
        clearInterval(pump);
      }
      // 3. Drain in-flight sink queues so buffered events are persisted.
      await sinks.drain();
      // 4. Final Tokemetry flush so committed events export before exit.
      if (batcher) {
        try {
          await batcher.flushOnce();
        } catch (err) {
          warn(`tokemetry: final flush failed: ${String(err)}`);
        }
      }
      // 5. Close every SQLite-backed component (outbox, budget, cache, mesh,
      //    sessions, traces, alerts).
      for (const c of closables) {
        try {
          c.close();
        } catch {
          // Best-effort: a failed close must not block the rest of teardown.
        }
      }
    },
  };
  return runtime;
}
