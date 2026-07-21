/**
 * Traces sink (epic AIPP-3, subtask 3.4).
 *
 * Hash-only trace index in traces/index.db (SQLite). Stores per-attempt metadata
 * and, optionally, pre-computed hashes of the request/response supplied
 * out-of-band. It NEVER stores request or response content -- only hashes -- so
 * traces are privacy-safe by construction (the legacy toolInputPreview and
 * replay bodies are intentionally omitted).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { UsageEventSink } from '../../lifecycle/event-sinks.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';
import { dataDir, DATA_FILES } from './paths.js';

/** Optional pre-computed hashes (never raw content). */
export interface TraceHashes {
  requestHash?: string;
  responseHash?: string;
}

/** A stored trace row. */
export interface TraceRow {
  event_id: string;
  logical_request_id: string;
  attempt_id: string;
  timestamp: string;
  provider: string;
  native_model: string;
  outcome: string;
  request_hash: string | null;
  response_hash: string | null;
}

export interface TracesSinkOptions {
  dir?: string;
  database?: Database.Database;
  /** Supplies hashes (already computed) for an event; never content. */
  getHashes?: (event: CanonicalUsageEvent) => TraceHashes | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
  event_id TEXT NOT NULL,
  logical_request_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  provider TEXT NOT NULL,
  native_model TEXT NOT NULL,
  outcome TEXT NOT NULL,
  request_hash TEXT,
  response_hash TEXT
);
CREATE INDEX IF NOT EXISTS traces_logical ON traces (logical_request_id);`;

const INSERT = `
INSERT INTO traces (event_id, logical_request_id, attempt_id, timestamp, provider, native_model, outcome, request_hash, response_hash)
VALUES (@event_id, @logical, @attempt, @ts, @provider, @model, @outcome, @reqHash, @resHash);`;

export class TracesSink implements UsageEventSink {
  readonly name = 'traces';
  private readonly db: Database.Database;
  private readonly getHashes?: (
    event: CanonicalUsageEvent,
  ) => TraceHashes | undefined;

  constructor(options: TracesSinkOptions = {}) {
    if (options.database) {
      this.db = options.database;
    } else {
      const dir = join(dataDir(options.dir), DATA_FILES.tracesDir);
      mkdirSync(dir, { recursive: true });
      this.db = new Database(join(dir, 'index.db'));
    }
    this.db.exec(SCHEMA);
    this.getHashes = options.getHashes;
  }

  onAttemptFinal(event: CanonicalUsageEvent): void {
    const hashes = this.getHashes?.(event);
    this.db.prepare(INSERT).run({
      event_id: event.eventId,
      logical: event.logicalRequestId,
      attempt: event.attemptId,
      ts: event.timestampCompleted,
      provider: event.provider,
      model: event.nativeModel,
      outcome: event.outcome,
      reqHash: hashes?.requestHash ?? null,
      resHash: hashes?.responseHash ?? null,
    });
  }

  /** Read trace rows for a logical request (for tests/diagnostics). */
  readByLogical(logicalRequestId: string): TraceRow[] {
    return this.db
      .prepare('SELECT * FROM traces WHERE logical_request_id = ?')
      .all(logicalRequestId) as TraceRow[];
  }

  close(): void {
    this.db.close();
  }
}
