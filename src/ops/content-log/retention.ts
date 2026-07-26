/**
 * Content-log retention and permissions (epic AIPP-11, subtask 11.6;
 * NFR-PRIV-003, decision D-006).
 *
 * The history log (history.jsonl) may contain full prompts and responses when
 * content logging is on. This module enforces the retention window and entry
 * cap from config and restricts the file to owner-only where the platform
 * supports it, so locally-stored content does not accumulate unbounded or stay
 * world-readable.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';

/** Retention policy for the history log. */
export interface RetentionPolicy {
  /** Maximum age of a retained entry, in days. */
  retentionDays: number;
  /** Maximum number of retained entries (newest kept). */
  maxEntries: number;
}

/** Outcome of a prune pass. */
export interface PruneResult {
  kept: number;
  pruned: number;
}

/** A history line with the fields retention needs (others are ignored). */
interface DatedEntry {
  timestamp?: string;
  raw: string;
}

/**
 * Prune the history log to the retention policy: drop entries older than
 * `retentionDays` and keep at most `maxEntries` (newest). The file is rewritten
 * atomically (temp + rename) and re-restricted to owner-only. Missing files and
 * unparseable lines are handled gracefully (a bad line is dropped, not fatal).
 */
export function pruneHistory(
  path: string,
  policy: RetentionPolicy,
  now: number = Date.now(),
): PruneResult {
  if (!existsSync(path)) {
    return { kept: 0, pruned: 0 };
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  const entries: DatedEntry[] = [];
  let dropped = 0;
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { timestamp?: string };
      entries.push({ timestamp: parsed.timestamp, raw });
    } catch {
      dropped += 1; // unparseable line: drop it
    }
  }

  const cutoff = now - policy.retentionDays * 24 * 60 * 60 * 1000;
  const withinWindow = entries.filter((e) => {
    if (!e.timestamp) {
      return true; // undated entries are kept (cannot age them out)
    }
    const t = Date.parse(e.timestamp);
    return Number.isNaN(t) || t >= cutoff;
  });

  // Keep only the newest maxEntries (entries are appended in chronological order).
  const kept =
    withinWindow.length > policy.maxEntries
      ? withinWindow.slice(withinWindow.length - policy.maxEntries)
      : withinWindow;

  const prunedCount = entries.length + dropped - kept.length;
  const body = kept.map((e) => e.raw).join('\n');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, kept.length > 0 ? `${body}\n` : '', 'utf8');
  renameSync(tmp, path);
  restrictOwnerOnly(path);

  return { kept: kept.length, pruned: prunedCount };
}

/**
 * Restrict a file to owner read/write (0o600) where the platform supports it.
 * Best-effort: on Windows POSIX modes are advisory and the call may be a no-op,
 * so failures are swallowed rather than blocking the request path.
 *
 * @returns true if the permission change was applied without error.
 */
export function restrictOwnerOnly(path: string): boolean {
  try {
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}
