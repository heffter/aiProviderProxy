/**
 * Corpus lint CLI (epic AIPP-1, subtask 1.3).
 *
 * Validates every committed fixture case under test/fixtures/<provider>/<case>/
 * for structural completeness and full scrubbing (no secrets, no unscrubbed
 * content, allowlisted headers only), and prints a coverage matrix.
 *
 * Exit code: 0 when all present cases pass (an empty corpus passes with a
 * warning), 1 when any case fails.
 *
 * Run (with a TypeScript-aware runtime, e.g. `node --import tsx`):
 *   node --import tsx test/fixtures/tools/lint-corpus.ts
 * The same validation is enforced in the test suite via corpus.test.ts.
 */

import { join } from 'node:path';
import { lintCorpus, PROVIDER_DIRS, type CorpusLintReport } from './corpus.js';

/** Corpus root: two levels up from this file (test/fixtures/tools -> test/fixtures). */
export function defaultCorpusRoot(): string {
  return join(__dirname, '..');
}

/** Render a human-readable report and return the process exit code. */
export function formatReport(report: CorpusLintReport): { text: string; code: number } {
  const lines: string[] = [];
  lines.push('Fixture corpus lint');
  lines.push('===================');
  lines.push('Coverage matrix (cases per provider):');
  for (const provider of PROVIDER_DIRS) {
    lines.push(`  ${provider.padEnd(12)} ${report.byProvider[provider] ?? 0}`);
  }
  lines.push('');

  const failures = report.results.filter((r) => !r.ok);
  for (const failure of failures) {
    lines.push(`FAIL ${failure.case}`);
    for (const error of failure.errors) {
      lines.push(`     - ${error}`);
    }
  }

  if (report.totalCases === 0) {
    lines.push('WARNING: corpus is empty (no cases captured yet). Passing.');
    return { text: lines.join('\n'), code: 0 };
  }

  lines.push(`${report.okCases}/${report.totalCases} cases passed.`);
  return { text: lines.join('\n'), code: failures.length === 0 ? 0 : 1 };
}

/** Lint the corpus at `baseDir`, print the report, and return the exit code. */
export function runLint(baseDir: string = defaultCorpusRoot()): number {
  const { text, code } = formatReport(lintCorpus(baseDir));
  // eslint-disable-next-line no-console
  console.log(text);
  return code;
}

// Execute when invoked directly (not when imported by tests).
if (require.main === module) {
  process.exit(runLint());
}
