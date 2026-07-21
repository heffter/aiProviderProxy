/**
 * Enforces integrity of the committed fixture corpus (epic AIPP-1).
 *
 * Runs the linter over the real test/fixtures tree so CI fails if any committed
 * case leaks raw content or secrets, drops a required file, or carries a
 * non-allowlisted header. Also asserts the corpus is non-empty so an accidental
 * wipe is caught.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { lintCorpus } from './tools/corpus.js';

describe('committed fixture corpus', () => {
  const report = lintCorpus(join(__dirname));

  it('contains cases (corpus is not empty)', () => {
    expect(report.totalCases).toBeGreaterThan(0);
  });

  it('has every case fully scrubbed and structurally complete', () => {
    const failures = report.results.filter((r) => !r.ok);
    expect(failures.map((f) => ({ case: f.case, errors: f.errors }))).toEqual(
      [],
    );
  });
});
