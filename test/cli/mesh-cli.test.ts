/**
 * `aipp mesh` CLI test (epic AIPP-11, subtask 11.5). Local-only, no egress.
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

describe('aipp mesh', () => {
  let dir: string;
  let cfg: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-meshcli-'));
    cfg = join(dir, 'config.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports off by default and toggles on', async () => {
    const s1 = capture();
    expect(
      await runCli(['mesh', 'status'], { io: s1.io, configFile: cfg }),
    ).toBe(0);
    expect(s1.out.join('\n')).toContain('mesh is off (local-only)');

    const s2 = capture();
    expect(await runCli(['mesh', 'on'], { io: s2.io, configFile: cfg })).toBe(
      0,
    );

    const s3 = capture();
    await runCli(['mesh', 'status'], { io: s3.io, configFile: cfg });
    expect(s3.out.join('\n')).toContain('mesh is on (local-only)');
  });

  it('has no sync/contribute subcommands (removed with remote sync)', async () => {
    const { io, err } = capture();
    const code = await runCli(['mesh', 'sync'], { io, configFile: cfg });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('usage: aipp mesh status|on|off');
  });
});
