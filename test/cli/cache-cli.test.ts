/**
 * `aipp cache` CLI test (epic AIPP-11, subtask 11.4). Read/clear only, no egress.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from '../../src/cli/cli.js';

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe('aipp cache', () => {
  let dir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-cachecli-'));
    savedHome = process.env.AIPP_HOME;
    process.env.AIPP_HOME = dir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AIPP_HOME;
    else process.env.AIPP_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports empty stats on a fresh install', async () => {
    const { io, out } = capture();
    const code = await runCli(['cache', 'stats'], { io });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('entries: 0');
  });

  it('clears the cache', async () => {
    const { io, out } = capture();
    const code = await runCli(['cache', 'clear'], { io });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('cache cleared');
  });

  it('prints usage for an unknown subcommand', async () => {
    const { io, err } = capture();
    const code = await runCli(['cache', 'bogus'], { io });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('usage: aipp cache stats|clear');
  });
});
