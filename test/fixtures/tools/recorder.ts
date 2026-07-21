/**
 * Fixture capture tooling (epic AIPP-1).
 *
 * Implementation relocated to src/fixtures/recorder.ts so the live proxy can
 * import it under tsc's rootDir; re-exported here to preserve the
 * test/fixtures/tools/ import path.
 */

export * from '../../../src/fixtures/recorder.js';
