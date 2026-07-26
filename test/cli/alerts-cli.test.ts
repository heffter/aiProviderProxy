/**
 * `aipp alerts` CLI test (epic AIPP-11, subtask 11.3). Read-only, no egress.
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

describe('aipp alerts', () => {
  let dir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-alertscli-'));
    savedHome = process.env.AIPP_HOME;
    process.env.AIPP_HOME = dir; // isolate alerts.db to the temp home
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AIPP_HOME;
    else process.env.AIPP_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints zeroed counts on a fresh install', async () => {
    const { io, out } = capture();
    const code = await runCli(['alerts', 'counts'], { io });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('threshold: 0');
    expect(out.join('\n')).toContain('breach: 0');
  });

  it('reports no alerts for recent on a fresh install', async () => {
    const { io, out } = capture();
    const code = await runCli(['alerts', 'recent'], { io });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('no alerts recorded');
  });

  it('prints usage for an unknown subcommand', async () => {
    const { io, err } = capture();
    const code = await runCli(['alerts', 'bogus'], { io });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('usage: aipp alerts recent|counts');
  });
});
