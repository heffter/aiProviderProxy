/**
 * Content-log retention + disclosure tests (epic AIPP-11, subtask 11.6).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pruneHistory,
  restrictOwnerOnly,
  contentLogDisclosure,
} from '../../src/ops/content-log/index.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed reference time

function entry(id: string, ageDays: number): string {
  return JSON.stringify({
    id,
    timestamp: new Date(NOW - ageDays * DAY).toISOString(),
  });
}

describe('pruneHistory', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-hist-'));
    path = join(dir, 'history.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('drops entries older than the retention window', () => {
    writeFileSync(
      path,
      [entry('old', 10), entry('fresh', 1)].join('\n') + '\n',
      'utf8',
    );
    const result = pruneHistory(
      path,
      { retentionDays: 7, maxEntries: 100 },
      NOW,
    );
    expect(result).toEqual({ kept: 1, pruned: 1 });
    const kept = readFileSync(path, 'utf8').trim().split('\n');
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0]).id).toBe('fresh');
  });

  it('caps to maxEntries, keeping the newest', () => {
    const lines = [entry('a', 3), entry('b', 2), entry('c', 1)];
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
    const result = pruneHistory(
      path,
      { retentionDays: 30, maxEntries: 2 },
      NOW,
    );
    expect(result.kept).toBe(2);
    const ids = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).id);
    expect(ids).toEqual(['b', 'c']); // oldest ('a') dropped
  });

  it('keeps undated entries (cannot age them out)', () => {
    writeFileSync(path, JSON.stringify({ id: 'x' }) + '\n', 'utf8');
    const result = pruneHistory(
      path,
      { retentionDays: 1, maxEntries: 100 },
      NOW,
    );
    expect(result.kept).toBe(1);
  });

  it('drops an unparseable line without failing', () => {
    writeFileSync(path, `{bad json\n${entry('ok', 0)}\n`, 'utf8');
    const result = pruneHistory(
      path,
      { retentionDays: 7, maxEntries: 100 },
      NOW,
    );
    expect(result.kept).toBe(1);
    expect(result.pruned).toBe(1);
  });

  it('is a no-op for a missing file', () => {
    expect(
      pruneHistory(join(dir, 'nope.jsonl'), {
        retentionDays: 7,
        maxEntries: 10,
      }),
    ).toEqual({ kept: 0, pruned: 0 });
  });

  it('empties the file when nothing survives', () => {
    writeFileSync(path, entry('old', 100) + '\n', 'utf8');
    pruneHistory(path, { retentionDays: 7, maxEntries: 100 }, NOW);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('');
  });
});

describe('restrictOwnerOnly', () => {
  it('does not throw and returns a boolean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipp-perm-'));
    const path = join(dir, 'f.jsonl');
    writeFileSync(path, 'x', 'utf8');
    expect(typeof restrictOwnerOnly(path)).toBe('boolean');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('contentLogDisclosure', () => {
  it('states where content is stored, retention, and how to disable', () => {
    const text = contentLogDisclosure({
      enabled: true,
      retentionDays: 7,
      home: '/home/x/.aiproviderproxy',
    });
    expect(text).toContain('Content logging is currently ON');
    expect(text).toContain('history.jsonl');
    expect(text).toContain('7 day(s)');
    expect(text).toContain('aipp content-log off');
    expect(text).toContain('never leaves your machine');
  });

  it('reflects the disabled state', () => {
    const text = contentLogDisclosure({
      enabled: false,
      retentionDays: 3,
      home: '/tmp/home',
    });
    expect(text).toContain('Content logging is currently OFF');
    expect(text).toContain('3 day(s)');
  });
});
