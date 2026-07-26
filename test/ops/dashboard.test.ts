/**
 * Dashboard data-builder tests (epic AIPP-11, subtask 11.1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readHistory,
  gateContent,
  listRuns,
  getRun,
  summarize,
} from '../../src/ops/dashboard/index.js';
import type { HistoryEntry } from '../../src/ops/trackers/history-sink.js';

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 2,
    id: 'r1',
    timestamp: '2026-07-26T12:00:00.000Z',
    provider: 'anthropic',
    requestedModel: 'claude-sonnet-4-5',
    routedModel: 'claude-sonnet-4-5',
    nativeModel: 'claude-sonnet-4-5',
    outcome: 'success',
    success: true,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    latencyMs: 100,
    costEstimateUsd: 0.01,
    ...over,
  };
}

describe('dashboard data', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-dash-'));
    path = join(dir, 'history.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads history newest-first with a limit', () => {
    writeFileSync(
      path,
      [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
      'utf8',
    );
    const runs = readHistory(path, 2);
    expect(runs.map((r) => r.id)).toEqual(['c', 'b']); // newest first, limited
  });

  it('returns an empty list for a missing file', () => {
    expect(readHistory(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('gates content off unless content logging is enabled', () => {
    const withContent = entry({
      content: { request: { a: 1 }, response: { b: 2 } },
    });
    expect(gateContent(withContent, true).content).toBeDefined();
    expect(gateContent(withContent, false).content).toBeUndefined();
  });

  it('lists and fetches runs with content gating', () => {
    writeFileSync(
      path,
      JSON.stringify(entry({ id: 'x', content: { request: { p: 1 } } })) + '\n',
      'utf8',
    );
    expect(listRuns(path, false)[0].content).toBeUndefined();
    expect(listRuns(path, true)[0].content).toBeDefined();
    expect(getRun(path, 'x', true)?.content).toBeDefined();
    expect(getRun(path, 'missing', true)).toBeUndefined();
  });

  it('summarizes cost, tokens, and provider/agent breakdown', () => {
    writeFileSync(
      path,
      [
        entry({
          id: '1',
          provider: 'anthropic',
          agentId: 'cc',
          costEstimateUsd: 0.02,
        }),
        entry({
          id: '2',
          provider: 'zai',
          success: false,
          costEstimateUsd: 0.01,
        }),
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
      'utf8',
    );
    const s = summarize(path);
    expect(s.totalRequests).toBe(2);
    expect(s.successRate).toBe(0.5);
    expect(s.totalCostUsd).toBeCloseTo(0.03, 5);
    expect(s.byProvider.anthropic.requests).toBe(1);
    expect(s.byProvider.zai.requests).toBe(1);
    expect(s.byAgent.cc.requests).toBe(1);
  });
});
