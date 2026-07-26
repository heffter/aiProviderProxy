/**
 * Agent-routing policy unit tests (epic AIPP-10, subtask 10.5;
 * FR-ROUTE-007/015/016). Priority resolution ported from the legacy engine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolvePolicy,
  loadPolicyFile,
  replayPolicy,
  type RoutingPolicy,
  type ReplayRecord,
} from '../../src/routing/policy.js';

const policy: RoutingPolicy = {
  version: 1,
  agents: {
    'claude-code': {
      fingerprint: 'fp-1',
      preferred: 'anthropic/claude-sonnet-4-6',
      escalateTo: 'anthropic/claude-opus-4-6',
      escalateOn: ['complexity_high'],
      neverDowngrade: true,
      tasks: {
        review: { preferred: 'anthropic/claude-opus-4-6' },
      },
    },
  },
  tasks: {
    summarize: { preferred: 'anthropic/claude-haiku-4-5' },
  },
};

describe('resolvePolicy priority', () => {
  it('1. agent-task override wins over everything', () => {
    const r = resolvePolicy(
      policy,
      'fp-1',
      'claude-code',
      'review',
      'simple',
      'x',
    );
    expect(r.resolvedBy).toBe('agent_task_override');
    expect(r.model).toBe('anthropic/claude-opus-4-6');
  });

  it('2. global task rule applies when no agent-task override', () => {
    const r = resolvePolicy(
      policy,
      'fp-1',
      'claude-code',
      'summarize',
      'simple',
      'x',
    );
    expect(r.resolvedBy).toBe('task_rule');
    expect(r.model).toBe('anthropic/claude-haiku-4-5');
  });

  it('3. agent rule applies for an unmatched task', () => {
    const r = resolvePolicy(
      policy,
      'fp-1',
      'claude-code',
      'other',
      'simple',
      'x',
    );
    expect(r.resolvedBy).toBe('agent_rule');
    expect(r.model).toBe('anthropic/claude-sonnet-4-6');
    expect(r.neverDowngrade).toBe(true);
  });

  it('escalates the agent rule on high complexity', () => {
    const r = resolvePolicy(
      policy,
      'fp-1',
      'claude-code',
      'other',
      'complex',
      'x',
    );
    expect(r.model).toBe('anthropic/claude-opus-4-6');
  });

  it('matches an agent by name when the fingerprint differs', () => {
    const r = resolvePolicy(
      policy,
      'other-fp',
      'claude-code',
      'other',
      'simple',
      'x',
    );
    expect(r.resolvedBy).toBe('agent_rule');
  });

  it('4. passes through the candidate when nothing matches', () => {
    const r = resolvePolicy(
      policy,
      undefined,
      'unknown',
      'nope',
      'simple',
      'candidate',
    );
    expect(r.resolvedBy).toBe('complexity_routing');
    expect(r.model).toBe('candidate');
  });

  it('reports default_routing for an empty policy', () => {
    const r = resolvePolicy(
      { version: 1 },
      undefined,
      undefined,
      't',
      'simple',
      'c',
    );
    expect(r.resolvedBy).toBe('default_routing');
    expect(r.model).toBe('c');
  });
});

describe('loadPolicyFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-policy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a version-1 YAML policy', () => {
    const path = join(dir, 'policy.yaml');
    writeFileSync(
      path,
      'version: 1\ntasks:\n  review:\n    preferred: anthropic/claude-opus-4-6\n',
      'utf8',
    );
    const loaded = loadPolicyFile(path);
    expect(loaded?.tasks?.review.preferred).toBe('anthropic/claude-opus-4-6');
  });

  it('returns null for a missing file', () => {
    expect(loadPolicyFile(join(dir, 'nope.yaml'))).toBeNull();
  });

  it('returns null for the wrong version', () => {
    const path = join(dir, 'policy.yaml');
    writeFileSync(path, 'version: 2\n', 'utf8');
    expect(loadPolicyFile(path)).toBeNull();
  });

  it('returns null for unparseable YAML', () => {
    const path = join(dir, 'policy.yaml');
    writeFileSync(path, 'version: 1\n  bad: [unterminated', 'utf8');
    expect(loadPolicyFile(path)).toBeNull();
  });
});

describe('replayPolicy', () => {
  it('reports which routed models a policy would change', () => {
    const records: ReplayRecord[] = [
      // Would be overridden by the global summarize task rule.
      {
        taskType: 'summarize',
        complexity: 'simple',
        candidateModel: 'anthropic/claude-sonnet-4-6',
      },
      // Already matches the agent rule -> unchanged.
      {
        agentName: 'claude-code',
        taskType: 'other',
        complexity: 'simple',
        candidateModel: 'anthropic/claude-sonnet-4-6',
      },
      // No rule matches -> unchanged.
      { taskType: 'nope', complexity: 'moderate', candidateModel: 'x/y' },
    ];
    const summary = replayPolicy(records, policy);
    expect(summary.total).toBe(3);
    expect(summary.changed).toBe(1);
    expect(summary.unchanged).toBe(2);
    expect(summary.changes[0]).toMatchObject({
      from: 'anthropic/claude-sonnet-4-6',
      to: 'anthropic/claude-haiku-4-5',
      resolvedBy: 'task_rule',
    });
  });
});
