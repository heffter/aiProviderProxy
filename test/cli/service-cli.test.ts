/**
 * `aipp service` CLI test (epic AIPP-13, subtask 13.3). Prints only; no egress,
 * no privileged action.
 */

import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from '../../src/cli/cli.js';

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe('aipp service template', () => {
  it('prints a template for an explicit platform and its install hint', async () => {
    const { io, out, err } = capture();
    const code = await runCli(
      ['service', 'template', '--platform', 'systemd'],
      {
        io,
      },
    );
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('[Service]');
    expect(out.join('\n')).toContain('aipp.js start');
    expect(err.join('\n')).toContain('systemctl');
  });

  it('emits a Windows scheduled-task XML when asked', async () => {
    const { io, out } = capture();
    await runCli(['service', 'template', '--platform', 'windows'], { io });
    expect(out.join('\n')).toContain('<LogonTrigger>');
  });

  it('defaults to the host platform', async () => {
    const { io, out } = capture();
    const code = await runCli(['service', 'template'], { io });
    expect(code).toBe(0);
    expect(out.join('\n').length).toBeGreaterThan(0);
  });

  it('prints usage for an unknown subcommand', async () => {
    const { io, err } = capture();
    const code = await runCli(['service', 'bogus'], { io });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('usage: aipp service template');
  });
});
