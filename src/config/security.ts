/**
 * Security helpers (epic AIPP-12, subtask 12.3; NFR-SEC-002, FR-AUTH-012).
 *
 * Constant-time credential comparison and owner-only permissions for local
 * state files. The token is never logged and never compared with a short-circuit
 * equality that could leak its length or a prefix via timing.
 */

import { timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Constant-time string comparison. Returns false for a length mismatch, but
 * still performs a comparison so the code path does not branch on length in a
 * timing-observable way.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare bb to itself to spend comparable time, then report the mismatch.
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Restrict a file to owner read/write (0o600) where the platform supports it.
 * Best-effort: POSIX modes are advisory on Windows, so failures are swallowed.
 *
 * @returns true if the permission change applied without error.
 */
export function secureFile(path: string): boolean {
  try {
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Local state files that may hold secrets or private content. */
export const STATE_FILES: readonly string[] = [
  'config.json',
  'config.json.bak',
  'credentials.json',
  'history.jsonl',
  'routing-log.jsonl',
  'budget.db',
  'alerts.db',
  'sessions.db',
  'tokemetry-outbox.db',
  'cache/index.db',
  'mesh/mesh.db',
  'traces/index.db',
];

/**
 * Apply owner-only permissions to every existing state file under `home`.
 * Best-effort and non-fatal; returns the paths that were successfully secured.
 */
export function secureStateFiles(home: string): string[] {
  const secured: string[] = [];
  for (const name of STATE_FILES) {
    const path = join(home, name);
    if (existsSync(path) && secureFile(path)) {
      secured.push(path);
    }
  }
  return secured;
}
