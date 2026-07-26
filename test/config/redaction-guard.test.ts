/**
 * Redaction-rollout guard (epic AIPP-12, subtask 12.1; FR-AUTH-004).
 *
 * An executable stand-in for the "no direct JSON.stringify of config/headers/
 * credentials" review: scans the new-gateway source tree and fails if a
 * diagnostic path stringifies a secret-bearing object directly instead of
 * routing through the redaction module (safeStringify / redactValue).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', '..', 'src');

// New-gateway source directories (the legacy flat files under src/*.ts are
// excluded from the gate and are deleted in AIPP-13).
const SCAN_DIRS = [
  'config',
  'gateway',
  'ops',
  'integrations',
  'lifecycle',
  'protocols',
  'providers',
  'models',
  'routing',
  'tools',
  'cli',
];

// Direct stringify of a secret-bearing object for diagnostics/logging.
const FORBIDDEN = [
  /JSON\.stringify\(\s*config\b/,
  /JSON\.stringify\(\s*headers\b/,
  /JSON\.stringify\(\s*request\.headers\b/,
  /JSON\.stringify\(\s*creds\b/,
  /JSON\.stringify\(\s*credential/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else if (name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('redaction rollout', () => {
  it('routes secret-bearing diagnostics through the redaction module', () => {
    const offenders: string[] = [];
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(srcRoot, d))) {
        if (file.endsWith('redact.ts')) {
          continue; // the redaction module itself
        }
        const src = readFileSync(file, 'utf8');
        for (const re of FORBIDDEN) {
          if (re.test(src)) {
            offenders.push(`${file} matched ${re}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
