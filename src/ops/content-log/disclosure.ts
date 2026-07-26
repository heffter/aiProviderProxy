/**
 * Content-log disclosure notice (epic AIPP-11, subtask 11.6; NFR-PRIV-003,
 * decision D-006).
 *
 * A plain-language notice, shown on first run and available to the CLI, stating
 * that full prompts and responses are stored locally by default, where, for how
 * long, and how to turn it off. The gateway performs no network egress of this
 * content; disclosure is about the LOCAL history log.
 */

import { join } from 'node:path';
import { DATA_FILES } from '../trackers/paths.js';

/** Inputs the disclosure text needs. */
export interface DisclosureInput {
  /** Whether content logging is currently enabled. */
  enabled: boolean;
  /** Retention window in days. */
  retentionDays: number;
  /** The config/data home directory. */
  home: string;
}

/**
 * Build the content-log disclosure notice. Deterministic (no timestamps) so it
 * can be asserted with a golden test.
 */
export function contentLogDisclosure(input: DisclosureInput): string {
  const historyPath = join(input.home, DATA_FILES.history);
  const state = input.enabled ? 'ON' : 'OFF';
  const lines = [
    'Privacy notice: local request logging',
    `  Content logging is currently ${state}.`,
    '  When ON, full prompt and response content is written to a local file:',
    `    ${historyPath}`,
    `  Entries are retained for ${input.retentionDays} day(s), then pruned.`,
    '  This data never leaves your machine. Turn it off with:',
    '    aipp content-log off',
    '  Check the current state with: aipp content-log status',
  ];
  return lines.join('\n');
}
