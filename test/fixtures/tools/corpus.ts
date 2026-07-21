/**
 * Fixture corpus layout, tap API, and linter (epic AIPP-1).
 *
 * Implementation relocated to src/fixtures/corpus.ts so the live proxy can
 * import the tap under tsc's rootDir; re-exported here to preserve the
 * test/fixtures/tools/ import path.
 */

export * from '../../../src/fixtures/corpus.js';
