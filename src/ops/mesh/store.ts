/**
 * Local mesh / osmosis store (epic AIPP-11, subtask 11.5; FR-IDENT-006,
 * decision D-005).
 *
 * A LOCAL-ONLY learning layer: knowledge atoms (semantic memory) and episodic
 * events (per-request history for pattern promotion). The legacy remote-sync
 * endpoint, the push/pull path, and the swarm cloud router are deleted entirely
 * -- this module performs NO network I/O of any kind. Disabled by default; the
 * store is only constructed when mesh is enabled.
 *
 * Content is metadata only: episodic events carry model/outcome/token counts,
 * never prompt or response text.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { dataFile } from '../trackers/paths.js';

/** A semantic knowledge atom. */
export interface KnowledgeAtom {
  id: number;
  kind: string;
  content: Record<string, unknown>;
  sessionId?: string;
  createdAt: number;
}

/** An episodic event (a completed request, metadata only). */
export interface EpisodicEvent {
  id: number;
  sessionId?: string;
  model: string;
  outcome: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
}

export interface MeshStoreOptions {
  dir?: string;
  database?: Database.Database;
  now?: () => number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_atoms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS episodic_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_atoms_created ON knowledge_atoms(created_at);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodic_events(session_id);`;

/**
 * The local knowledge/episodic store. Every method touches only SQLite; there
 * is no network code path (verified by the egress-guard test).
 */
export class MeshStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(options: MeshStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.database) {
      this.db = options.database;
    } else {
      const path = dataFile('mesh/mesh.db', options.dir);
      mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path);
    }
    this.db.exec(SCHEMA);
  }

  /** Capture a semantic knowledge atom. */
  captureAtom(atom: {
    kind: string;
    content: Record<string, unknown>;
    sessionId?: string;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO knowledge_atoms (kind, content, session_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        atom.kind,
        JSON.stringify(atom.content),
        atom.sessionId ?? null,
        this.now(),
      );
    return Number(info.lastInsertRowid);
  }

  /** Capture an episodic event (metadata only). */
  captureEpisode(event: {
    sessionId?: string;
    model: string;
    outcome: string;
    inputTokens: number;
    outputTokens: number;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO episodic_events
           (session_id, model, outcome, input_tokens, output_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.sessionId ?? null,
        event.model,
        event.outcome,
        event.inputTokens,
        event.outputTokens,
        this.now(),
      );
    return Number(info.lastInsertRowid);
  }

  /** The most recent knowledge atoms (semantic memory query). */
  querySemantic(limit = 50): KnowledgeAtom[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, content, session_id, created_at
         FROM knowledge_atoms ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      kind: string;
      content: string;
      session_id: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      content: JSON.parse(r.content) as Record<string, unknown>,
      sessionId: r.session_id ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** Recent episodic events, optionally scoped to a session. */
  queryEpisodic(sessionId?: string, limit = 50): EpisodicEvent[] {
    const rows = (
      sessionId
        ? this.db
            .prepare(
              `SELECT id, session_id, model, outcome, input_tokens, output_tokens, created_at
             FROM episodic_events WHERE session_id = ?
             ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(sessionId, limit)
        : this.db
            .prepare(
              `SELECT id, session_id, model, outcome, input_tokens, output_tokens, created_at
             FROM episodic_events ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(limit)
    ) as Array<{
      id: number;
      session_id: string | null;
      model: string;
      outcome: string;
      input_tokens: number;
      output_tokens: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id ?? undefined,
      model: r.model,
      outcome: r.outcome,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      createdAt: r.created_at,
    }));
  }

  /** Counts for the mesh stats endpoint. */
  stats(): { atoms: number; episodes: number } {
    const atoms = (
      this.db.prepare('SELECT COUNT(*) AS c FROM knowledge_atoms').get() as {
        c: number;
      }
    ).c;
    const episodes = (
      this.db.prepare('SELECT COUNT(*) AS c FROM episodic_events').get() as {
        c: number;
      }
    ).c;
    return { atoms, episodes };
  }

  close(): void {
    this.db.close();
  }
}
