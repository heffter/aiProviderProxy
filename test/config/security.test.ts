/**
 * Security helper tests (epic AIPP-12, subtask 12.3; NFR-SEC-002).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  timingSafeEqualStr,
  secureFile,
  secureStateFiles,
} from '../../src/config/security.js';

describe('timingSafeEqualStr', () => {
  it('is true only for an exact match', () => {
    expect(timingSafeEqualStr('s3cret', 's3cret')).toBe(true);
    expect(timingSafeEqualStr('s3cret', 's3crey')).toBe(false);
  });

  it('is false for a length mismatch (no early-return leak)', () => {
    expect(timingSafeEqualStr('short', 'longer-token')).toBe(false);
    expect(timingSafeEqualStr('', 'x')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});

describe('secureFile / secureStateFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-sec-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns a boolean and does not throw for a missing file', () => {
    expect(typeof secureFile(join(dir, 'nope'))).toBe('boolean');
  });

  it('secures only the state files that exist', () => {
    writeFileSync(join(dir, 'config.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'history.jsonl'), '', 'utf8');
    const secured = secureStateFiles(dir);
    // Both existing files are returned; the many non-existent ones are skipped.
    expect(secured.some((p) => p.endsWith('config.json'))).toBe(true);
    expect(secured.some((p) => p.endsWith('history.jsonl'))).toBe(true);
    expect(secured.every((p) => !p.endsWith('budget.db'))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'applies owner-only mode on POSIX',
    () => {
      const path = join(dir, 'config.json');
      writeFileSync(path, '{}', 'utf8');
      chmodSync(path, 0o644);
      secureFile(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );
});
