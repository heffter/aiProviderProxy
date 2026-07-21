/**
 * Data-file locations for local sink adapters (epic AIPP-3, subtask 3.4).
 *
 * Reuses the legacy file names under the aipp home so data migrated from
 * RelayPlane (AIPP-2) stays readable by these sinks.
 */

import { join } from 'node:path';
import { configHome } from '../../config/index.js';

/** Resolve the data directory (defaults to the aipp config home). */
export function dataDir(dir?: string): string {
  return dir ?? configHome();
}

/** Legacy-compatible data file names. */
export const DATA_FILES = {
  history: 'history.jsonl',
  routingLog: 'routing-log.jsonl',
  agents: 'agents.json',
  sessions: 'sessions.db',
  tracesDir: 'traces',
} as const;

/** Absolute path to a data file within `dir` (or the default home). */
export function dataFile(name: string, dir?: string): string {
  return join(dataDir(dir), name);
}
