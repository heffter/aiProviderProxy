/**
 * Unit tests for the parity diff engine and report model (epic AIPP-1, subtask 1.4).
 */

import { describe, it, expect } from 'vitest';
import { diffValues, summarize, formatReport, type CaseParity } from './report.js';

describe('diffValues', () => {
  it('returns no diffs for deep-equal values', () => {
    const value = { a: 1, b: [{ c: 'x' }], d: null };
    expect(diffValues(value, structuredClone(value))).toEqual([]);
  });

  it('flags changed primitives (e.g. usage numbers)', () => {
    const diffs = diffValues({ usage: { output_tokens: 25 } }, { usage: { output_tokens: 26 } });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: '$.usage.output_tokens', kind: 'changed', expected: 25, actual: 26 });
  });

  it('flags reordered array elements (event ordering)', () => {
    const expected = [{ type: 'a' }, { type: 'b' }, { type: 'c' }];
    const actual = [{ type: 'a' }, { type: 'c' }, { type: 'b' }];
    const diffs = diffValues(expected, actual);
    expect(diffs.map((d) => d.path)).toEqual(['$[1].type', '$[2].type']);
  });

  it('flags array length mismatch and reports extra/missing elements', () => {
    const diffs = diffValues([1, 2], [1, 2, 3]);
    expect(diffs.some((d) => d.kind === 'length')).toBe(true);
    expect(diffs.some((d) => d.kind === 'extra' && d.path === '$[2]')).toBe(true);
  });

  it('flags missing and extra object keys', () => {
    const diffs = diffValues({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(diffs.some((d) => d.kind === 'missing' && d.path === '$.b')).toBe(true);
    expect(diffs.some((d) => d.kind === 'extra' && d.path === '$.c')).toBe(true);
  });

  it('flags type mismatches', () => {
    const diffs = diffValues({ x: [] }, { x: {} });
    expect(diffs[0]).toMatchObject({ path: '$.x', kind: 'type' });
  });
});

describe('summarize / formatReport', () => {
  const cases: CaseParity[] = [
    { case: 'a/ok', ok: true, diffs: [] },
    { case: 'a/bad', ok: false, diffs: [{ path: '$.usage', kind: 'changed', expected: 1, actual: 2 }] },
  ];

  it('aggregates pass/fail counts', () => {
    const report = summarize('legacy', cases);
    expect(report).toMatchObject({ target: 'legacy', totalCases: 2, okCases: 1, ok: false });
  });

  it('renders failing cases with their diffs', () => {
    const text = formatReport(summarize('legacy', cases));
    expect(text).toContain('1/2 cases match');
    expect(text).toContain('FAIL a/bad');
    expect(text).not.toContain('a/ok');
  });
});
