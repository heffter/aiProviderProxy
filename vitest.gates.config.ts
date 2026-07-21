import { defineConfig } from 'vitest/config';

// Vitest config for the AIPP-2 quality gates (subtask 2.2).
//
// Runs only new-code tests (excludes the legacy e2e suite, which needs a built
// dist and native sqlite) and enforces 80% line / 70% branch coverage over new
// AIPP-2 source directories.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Load the native better-sqlite3 addon directly instead of transforming it.
    server: {
      deps: {
        external: ['better-sqlite3'],
      },
    },
    include: [
      'test/fixtures/**/*.test.ts',
      'test/parity/**/*.test.ts',
      'test/config/**/*.test.ts',
      'test/cli/**/*.test.ts',
      'test/lifecycle/**/*.test.ts',
      'test/ops/**/*.test.ts',
      'test/providers/**/*.test.ts',
      'test/skeleton.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: [
        'src/gateway/**',
        'src/protocols/**',
        'src/providers/**',
        'src/models/**',
        'src/lifecycle/**',
        'src/routing/**',
        'src/integrations/**',
        'src/ops/**',
        'src/config/**',
        'src/cli/**',
        'src/identity.ts',
      ],
      // The executable entrypoint self-executes on import and cannot be unit-tested.
      exclude: ['src/cli/aipp.ts'],
      all: true,
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
      },
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
