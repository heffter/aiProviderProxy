#!/usr/bin/env node
/**
 * aipp CLI executable entrypoint (epic AIPP-2, subtask 2.6).
 *
 * Thin wrapper that runs the command router and exits with its code. All logic
 * lives in {@link runCli} so it can be tested without spawning a process.
 */

import { runCli } from './cli.js';

runCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
