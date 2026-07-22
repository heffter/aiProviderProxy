/**
 * Tokemetry durable outbox (epic AIPP-5, subtask 5.1; FR-TOK-001.., NFR-REL-001..005).
 *
 * A SQLite outbox with commit-before-export semantics: a canonical usage event
 * is durably committed here (synchronously) before any network export is
 * attempted, so a crash or forced kill after commit never loses an event -- on
 * restart, pending rows are simply re-claimed. Rows move pending -> exported on
 * a successful ingest, or pending -> dead (DLQ) when they exhaust retries.
 *
 * The store is content-free: it persists only the canonical event (which itself
 * carries no prompt/response content by construction, AIPP-3).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';

/** Row states. */
export type OutboxState = 'pending' | 'exported' | 'dead';

/** A persisted outbox row. */
export interface OutboxRecord {
  id: number;
  event_id: string;
  finality: string;
  sequence: number;
  payload: string;
  state: OutboxState;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  last_error: string | null;
}

export interface OutboxCounts {
  pending: number;
  exported: number;
  dead: number;
}

export interface OutboxOptions {
  /** File path for the outbox DB (ignored when `database` is given). */
  path?: string;
  /** Inject an open database (e.g. `new Database(':memory:')`) for tests. */
  database?: Database.Database;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  finality TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (state, next_attempt_at, id);`;

export class TokemetryOutbox {
  private readonly db: Database.Database;

  constructor(options: OutboxOptions = {}) {
    if (options.database) {
      this.db = options.database;
    } else {
      const path = options.path ?? ':memory:';
      if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true });
      }
      this.db = new Database(path);
    }
    // WAL improves durability/concurrency for a file-backed outbox.
    try {
      this.db.pragma('journal_mode = WAL');
    } catch {
      // in-memory or restricted fs: keep the default journal
    }
    this.db.exec(SCHEMA);
  }

  /**
   * Durably commit an event to the outbox (commit-before-export). Returns the
   * row id. Synchronous: the write is fsynced before the call returns.
   */
  enqueue(event: CanonicalUsageEvent, now: number = Date.now()): number {
    const info = this.db
      .prepare(
        `INSERT INTO outbox_events (event_id, finality, sequence, payload, state, created_at, next_attempt_at)
         VALUES (@event_id, @finality, @sequence, @payload, 'pending', @now, 0)`,
      )
      .run({
        event_id: event.eventId,
        finality: event.finality,
        sequence: event.sequence,
        payload: JSON.stringify(event),
        now,
      });
    return Number(info.lastInsertRowid);
  }

  /** Claim up to `limit` pending rows whose backoff has elapsed (FIFO by id). */
  claimBatch(limit: number, now: number = Date.now()): OutboxRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM outbox_events
         WHERE state = 'pending' AND next_attempt_at <= @now
         ORDER BY id ASC LIMIT @limit`,
      )
      .all({ now, limit }) as OutboxRecord[];
  }

  /** Mark rows exported (successful ingest). */
  markExported(ids: number[]): void {
    if (ids.length === 0) {
      return;
    }
    const stmt = this.db.prepare(
      `UPDATE outbox_events SET state = 'exported', last_error = NULL WHERE id = ?`,
    );
    const tx = this.db.transaction((rows: number[]) => {
      for (const id of rows) {
        stmt.run(id);
      }
    });
    tx(ids);
  }

  /** Record a failed attempt and schedule a retry. */
  markFailed(ids: number[], nextAttemptAt: number, error: string): void {
    if (ids.length === 0) {
      return;
    }
    const stmt = this.db.prepare(
      `UPDATE outbox_events
       SET attempts = attempts + 1, next_attempt_at = @next, last_error = @error
       WHERE id = @id`,
    );
    const tx = this.db.transaction((rows: number[]) => {
      for (const id of rows) {
        stmt.run({ id, next: nextAttemptAt, error });
      }
    });
    tx(ids);
  }

  /** Move rows to the dead-letter state (exhausted retries / poison). */
  markDead(ids: number[], error: string): void {
    if (ids.length === 0) {
      return;
    }
    const stmt = this.db.prepare(
      `UPDATE outbox_events SET state = 'dead', last_error = @error WHERE id = @id`,
    );
    const tx = this.db.transaction((rows: number[]) => {
      for (const id of rows) {
        stmt.run({ id, error });
      }
    });
    tx(ids);
  }

  /** Row counts by state. */
  counts(): OutboxCounts {
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM outbox_events GROUP BY state`)
      .all() as Array<{ state: OutboxState; n: number }>;
    const counts: OutboxCounts = { pending: 0, exported: 0, dead: 0 };
    for (const row of rows) {
      counts[row.state] = row.n;
    }
    return counts;
  }

  /** Delete exported rows older than `beforeMs` (retention). Returns rows removed. */
  purgeExported(beforeMs: number): number {
    return this.db
      .prepare(
        `DELETE FROM outbox_events WHERE state = 'exported' AND created_at < ?`,
      )
      .run(beforeMs).changes;
  }

  /** Read dead-lettered rows (for diagnostics/CLI). */
  deadLetters(): OutboxRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM outbox_events WHERE state = 'dead' ORDER BY id ASC`,
      )
      .all() as OutboxRecord[];
  }

  close(): void {
    this.db.close();
  }
}
