/**
 * Parity diffing and report model (epic AIPP-1, subtask 1.4).
 *
 * A structural deep-diff over normalized values. Arrays are compared
 * element-wise so a reordered SSE event stream produces per-index diffs; object
 * keys are compared so missing/extra fields surface; primitives (including usage
 * numbers) are compared by strict equality.
 */

/** Kind of structural difference. */
export type DiffKind = 'changed' | 'missing' | 'extra' | 'type' | 'length';

/** A single structural difference at a JSON path. */
export interface Diff {
  path: string;
  kind: DiffKind;
  expected?: unknown;
  actual?: unknown;
}

/** Parity outcome for one replayed case. */
export interface CaseParity {
  case: string;
  ok: boolean;
  diffs: Diff[];
}

/** Machine-readable parity report across a set of cases against one target. */
export interface ParityReport {
  target: string;
  totalCases: number;
  okCases: number;
  ok: boolean;
  cases: CaseParity[];
}

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/** Deep structural diff between an expected and an actual (already normalized) value. */
export function diffValues(
  expected: unknown,
  actual: unknown,
  path = '$',
): Diff[] {
  const diffs: Diff[] = [];
  const expType = typeOf(expected);
  const actType = typeOf(actual);

  if (expType !== actType) {
    diffs.push({ path, kind: 'type', expected, actual });
    return diffs;
  }

  if (expType === 'array') {
    const expArr = expected as unknown[];
    const actArr = actual as unknown[];
    if (expArr.length !== actArr.length) {
      diffs.push({
        path,
        kind: 'length',
        expected: expArr.length,
        actual: actArr.length,
      });
    }
    const max = Math.max(expArr.length, actArr.length);
    for (let i = 0; i < max; i += 1) {
      const childPath = `${path}[${i}]`;
      if (i >= expArr.length) {
        diffs.push({ path: childPath, kind: 'extra', actual: actArr[i] });
      } else if (i >= actArr.length) {
        diffs.push({ path: childPath, kind: 'missing', expected: expArr[i] });
      } else {
        diffs.push(...diffValues(expArr[i], actArr[i], childPath));
      }
    }
    return diffs;
  }

  if (expType === 'object') {
    const expObj = expected as Record<string, unknown>;
    const actObj = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(expObj), ...Object.keys(actObj)]);
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      const inExp = Object.prototype.hasOwnProperty.call(expObj, key);
      const inAct = Object.prototype.hasOwnProperty.call(actObj, key);
      if (!inAct) {
        diffs.push({ path: childPath, kind: 'missing', expected: expObj[key] });
      } else if (!inExp) {
        diffs.push({ path: childPath, kind: 'extra', actual: actObj[key] });
      } else {
        diffs.push(...diffValues(expObj[key], actObj[key], childPath));
      }
    }
    return diffs;
  }

  if (expected !== actual) {
    diffs.push({ path, kind: 'changed', expected, actual });
  }
  return diffs;
}

/** Aggregate per-case results into a report. */
export function summarize(target: string, cases: CaseParity[]): ParityReport {
  const okCases = cases.filter((c) => c.ok).length;
  return {
    target,
    totalCases: cases.length,
    okCases,
    ok: okCases === cases.length,
    cases,
  };
}

/** Render a human-readable summary of a parity report. */
export function formatReport(report: ParityReport): string {
  const lines: string[] = [];
  lines.push(`Parity report vs ${report.target}`);
  lines.push('='.repeat(24));
  lines.push(`${report.okCases}/${report.totalCases} cases match.`);
  for (const c of report.cases.filter((x) => !x.ok)) {
    lines.push(
      `FAIL ${c.case} (${c.diffs.length} diff${c.diffs.length === 1 ? '' : 's'})`,
    );
    for (const d of c.diffs.slice(0, 20)) {
      lines.push(
        `     - ${d.kind} at ${d.path}: expected ${JSON.stringify(d.expected)}, actual ${JSON.stringify(d.actual)}`,
      );
    }
  }
  return lines.join('\n');
}
