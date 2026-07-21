/**
 * Fixture content scrubber (epic AIPP-1).
 *
 * The implementation was relocated to src/fixtures/scrubber.ts so the live proxy
 * (src/standalone-proxy.ts) can import it under tsc's rootDir; this module
 * re-exports it so the corpus tooling and tests keep their test/fixtures/tools/
 * import paths.
 */

export * from '../../../src/fixtures/scrubber.js';
