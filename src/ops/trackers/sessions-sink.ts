/**
 * Sessions sink (epic AIPP-3, subtask 3.4).
 *
 * Upserts per-session aggregates into sessions.db (SQLite) keyed by session id
 * (X-Claude-Code-Session-Id or an upstream-assigned synthetic id, already
 * resolved onto the event). Events without a session id are ignored. No prompt
 * content is stored.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { UsageEventSink } from '../../lifecycle/event-sinks.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';
import { dataFile, DATA_FILES } from './paths.js';

/** Aggregated per-session row. */
export interface SessionRow {
  session_id: string;
  first_seen: string;
  last_seen: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
}

export interface SessionsSinkOptions {
  dir?: string;
  /** Inject an open database (e.g. `new Database(':memory:')`) for tests. */
  database?: Database.Database;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);`;

const UPSERT = `
INSERT INTO sessions (session_id, first_seen, last_seen, request_count, input_tokens, output_tokens)
VALUES (@session_id, @ts, @ts, 1, @input, @output)
ON CONFLICT(session_id) DO UPDATE SET
  last_seen = @ts,
  request_count = request_count + 1,
  input_tokens = input_tokens + @input,
  output_tokens = output_tokens + @output;`;

export class SessionsSink implements UsageEventSink {
  readonly name = 'sessions';
  private readonly db: Database.Database;

  constructor(options: SessionsSinkOptions = {}) {
    if (options.database) {
      this.db = options.database;
    } else {
      const path = dataFile(DATA_FILES.sessions, options.dir);
      mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path);
    }
    this.db.exec(SCHEMA);
  }

  onLogicalRequestFinal(event: CanonicalUsageEvent): void {
    if (!event.sessionId) {
      return;
    }
    this.db.prepare(UPSERT).run({
      session_id: event.sessionId,
      ts: event.timestampCompleted,
      input: event.inputTokens,
      output: event.outputTokens,
    });
  }

  /** Read a session row (for tests/diagnostics). */
  read(sessionId: string): SessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as SessionRow | undefined;
  }

  close(): void {
    this.db.close();
  }
}
