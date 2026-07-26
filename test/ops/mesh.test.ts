/**
 * Local mesh store + sink + egress-guard tests (epic AIPP-11, subtask 11.5).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { MeshStore, MeshSink } from '../../src/ops/mesh/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';

function store() {
  return new MeshStore({ database: new Database(':memory:'), now: () => 1000 });
}

describe('MeshStore', () => {
  it('captures and queries knowledge atoms (newest first)', () => {
    const s = store();
    s.captureAtom({ kind: 'fact', content: { a: 1 } });
    s.captureAtom({ kind: 'tip', content: { b: 2 }, sessionId: 'sess' });
    const atoms = s.querySemantic();
    expect(atoms).toHaveLength(2);
    expect(atoms[0].kind).toBe('tip');
    expect(atoms[0].content).toEqual({ b: 2 });
    expect(atoms[0].sessionId).toBe('sess');
  });

  it('captures and queries episodic events, optionally by session', () => {
    const s = store();
    s.captureEpisode({
      sessionId: 's1',
      model: 'm',
      outcome: 'success',
      inputTokens: 1,
      outputTokens: 2,
    });
    s.captureEpisode({
      sessionId: 's2',
      model: 'm',
      outcome: 'success',
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(s.queryEpisodic()).toHaveLength(2);
    expect(s.queryEpisodic('s1')).toHaveLength(1);
    expect(s.queryEpisodic('s1')[0].inputTokens).toBe(1);
  });

  it('reports stats', () => {
    const s = store();
    s.captureAtom({ kind: 'x', content: {} });
    s.captureEpisode({
      model: 'm',
      outcome: 'success',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(s.stats()).toEqual({ atoms: 1, episodes: 1 });
  });
});

describe('MeshSink', () => {
  it('records one metadata-only episode per logical request', () => {
    const s = store();
    const sink = new MeshSink(s);
    sink.onLogicalRequestFinal({
      sessionId: 'sess',
      nativeModel: 'claude-sonnet-4-6',
      outcome: 'success',
      inputTokens: 10,
      outputTokens: 5,
    } as unknown as CanonicalUsageEvent);
    const events = s.queryEpisodic();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      outcome: 'success',
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});

describe('egress guard: no network code path in the mesh module', () => {
  it('contains no fetch/http/remote-URL references', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const meshDir = join(here, '..', '..', 'src', 'ops', 'mesh');
    const forbidden = [
      'fetch(',
      'http://',
      'https://',
      'node:http',
      'node:https',
      'node:net',
      'XMLHttpRequest',
      'WebSocket',
      'osmosis-mesh',
      'relayplane.com',
      'fly.dev',
      '.contribute',
      'syncWith',
    ];
    for (const file of ['store.ts', 'sink.ts', 'index.ts']) {
      const src = readFileSync(join(meshDir, file), 'utf8');
      for (const token of forbidden) {
        expect(src, `${file} must not contain "${token}"`).not.toContain(token);
      }
    }
  });
});
