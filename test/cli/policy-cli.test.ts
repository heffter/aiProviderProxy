/**
 * `aipp policy replay` CLI test (epic AIPP-10, subtask 10.5; FR-ROUTE-016).
 *
 * Regression test for the replay tool against a routing-log v2 file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from '../../src/cli/cli.js';

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe('aipp policy replay', () => {
  let dir: string;
  let policyPath: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-policycli-'));
    policyPath = join(dir, 'policy.yaml');
    logPath = join(dir, 'routing-log.jsonl');
    writeFileSync(
      policyPath,
      'version: 1\ntasks:\n  review:\n    preferred: anthropic/claude-opus-4-6\n',
      'utf8',
    );
    // Two v2 routing-log records: one under the review task (would change), one
    // under an unmatched task (unchanged).
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          schemaVersion: 2,
          taskType: 'review',
          complexity: 'moderate',
          routedModel: 'anthropic/claude-sonnet-4-6',
        }),
        JSON.stringify({
          schemaVersion: 2,
          taskType: 'chat',
          complexity: 'simple',
          routedModel: 'anthropic/claude-haiku-4-5',
        }),
      ].join('\n') + '\n',
      'utf8',
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('replays the log and reports the changed decisions', async () => {
    const { io, out } = capture();
    const code = await runCli(
      ['policy', 'replay', '--policy', policyPath, '--log', logPath],
      { io },
    );
    expect(code).toBe(0);
    expect(out[0]).toBe('replayed 2 record(s): 1 changed, 1 unchanged');
    expect(out.join('\n')).toContain(
      'anthropic/claude-sonnet-4-6 -> anthropic/claude-opus-4-6  (task_rule)',
    );
  });

  it('errors when the policy file is missing or invalid', async () => {
    const { io, err } = capture();
    const code = await runCli(
      [
        'policy',
        'replay',
        '--policy',
        join(dir, 'nope.yaml'),
        '--log',
        logPath,
      ],
      { io },
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no valid policy');
  });

  it('prints usage for an unknown subcommand', async () => {
    const { io, err } = capture();
    const code = await runCli(['policy', 'bogus'], { io });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('usage: aipp policy replay');
  });
});
