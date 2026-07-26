/**
 * Content-log CLI + startup disclosure/retention (epic AIPP-11, subtask 11.6).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, contentLogStartup, type CliIO } from '../../src/cli/cli.js';
import { defaultConfig } from '../../src/config/index.js';

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe('aipp content-log status disclosure', () => {
  let dir: string;
  let cfg: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-clcli-'));
    cfg = join(dir, 'config.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prints the state and the privacy disclosure', async () => {
    const { io, out } = capture();
    const code = await runCli(['content-log', 'status'], {
      io,
      configFile: cfg,
    });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('content logging is on'); // default
    expect(text).toContain('history.jsonl');
    expect(text).toContain('aipp content-log off');
  });

  it('toggles the flag and reflects it in status', async () => {
    const { io } = capture();
    expect(await runCli(['content-log', 'off'], { io, configFile: cfg })).toBe(
      0,
    );
    const s = capture();
    await runCli(['content-log', 'status'], { io: s.io, configFile: cfg });
    expect(s.out.join('\n')).toContain('content logging is off');
  });
});

describe('contentLogStartup', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-clstart-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prunes the history log and prints the disclosure on first run', () => {
    const historyPath = join(dir, 'history.jsonl');
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    const fresh = new Date().toISOString();
    writeFileSync(
      historyPath,
      [
        JSON.stringify({ id: 'old', timestamp: old }),
        JSON.stringify({ id: 'fresh', timestamp: fresh }),
      ].join('\n') + '\n',
      'utf8',
    );

    const { io, out } = capture();
    contentLogStartup(io, defaultConfig(), dir, true);

    // Retention dropped the 30-day-old entry (default window 7d).
    const kept = readFileSync(historyPath, 'utf8').trim().split('\n');
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0]).id).toBe('fresh');
    // First-run disclosure was printed.
    expect(out.join('\n')).toContain('Privacy notice');
  });

  it('does not print the disclosure on a subsequent run', () => {
    const { io, out } = capture();
    contentLogStartup(io, defaultConfig(), dir, false);
    expect(out.join('\n')).not.toContain('Privacy notice');
  });
});
