// ESLint flat config (epic AIPP-2, subtask 2.2).
//
// Zero-warning policy for NEW (AIPP-2+) code and tests. Legacy RelayPlane
// sources under src/ are intentionally excluded until they are migrated or
// deleted in later epics; linting them wholesale would drown the signal.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Legacy RelayPlane sources and their tests are not linted yet.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test/e2e/**', '__tests__/**'],
  },
  {
    files: [
      'src/gateway/**/*.ts',
      'src/protocols/**/*.ts',
      'src/providers/**/*.ts',
      'src/models/**/*.ts',
      'src/lifecycle/**/*.ts',
      'src/routing/**/*.ts',
      'src/integrations/**/*.ts',
      'src/ops/**/*.ts',
      'src/config/**/*.ts',
      'src/cli/**/*.ts',
      'src/identity.ts',
      'src/fixtures/**/*.ts',
      'test/**/*.ts',
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // TypeScript resolves identifiers; no-undef would false-flag Node/DOM globals.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  prettier,
);
