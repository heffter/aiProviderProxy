/**
 * Replay/parity harness (epic AIPP-1, subtask 1.4).
 *
 * Replays recorded fixture requests against a target proxy (the legacy proxy
 * today, the new gateway later), captures the response or SSE event sequence,
 * and diffs it against the recorded expectation.
 *
 * Because LLM output is non-deterministic, the live response is first scrubbed
 * into the same placeholder space as the fixture and then normalized (ids,
 * timestamps, latency, content) before diffing -- so parity is measured on
 * protocol structure, event ordering, and usage numbers rather than exact text.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { scrubHeaders, scrubValue } from '../fixtures/tools/scrubber.js';
import type { CorpusCase } from '../fixtures/tools/corpus.js';
import { DEFAULT_NORMALIZERS, normalizeHeaders, normalizeValue, type NormalizerConfig } from './normalizers.js';
import { diffValues, summarize, type CaseParity, type Diff, type ParityReport } from './report.js';

/** A proxy to replay against. `headers` are merged onto every request (e.g. auth). */
export interface ReplayTarget {
  name: string;
  baseUrl: string;
  headers?: Record<string, string>;
}

/** The request portion of a fixture, replayed verbatim (plus target headers). */
export interface FixtureRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A parity case: a request plus its recorded expectation (unary and/or stream). */
export interface ParityCase {
  name: string;
  request: FixtureRequest;
  expectedResponse?: { status: number; headers: Record<string, string>; body: unknown } | null;
  expectedStream?: Array<{ event: string; data: unknown }> | null;
}

/** The captured result of replaying a request. */
export interface ReplayResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  streamEvents?: Array<{ event: string; data: unknown }>;
}

/** Parse a raw SSE body into ordered events. Handles Anthropic (event+data) and OpenAI (data-only, [DONE]). */
export function parseSse(raw: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    const dataStr = dataLines.join('\n');
    if (dataStr.length === 0 && event.length === 0) {
      continue;
    }
    let data: unknown = dataStr;
    if (dataStr.length > 0 && dataStr !== '[DONE]') {
      try {
        data = JSON.parse(dataStr);
      } catch {
        data = dataStr;
      }
    }
    if (event.length === 0) {
      if (dataStr === '[DONE]') {
        event = 'done';
      } else if (data !== null && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string') {
        event = (data as { type: string }).type;
      } else {
        event = 'data';
      }
    }
    events.push({ event, data });
  }
  return events;
}

function performRequest(
  target: ReplayTarget,
  req: FixtureRequest,
): Promise<{ status: number; headers: IncomingHttpHeaders; rawBody: string }> {
  const url = new URL(req.url, target.baseUrl);
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const headers: Record<string, string> = { ...(req.headers ?? {}), ...(target.headers ?? {}) };
  if (payload !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const clientReq = requestFn(
      { method: req.method, hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, rawBody: buf }));
      },
    );
    clientReq.on('error', reject);
    if (payload !== undefined) {
      clientReq.write(payload);
    }
    clientReq.end();
  });
}

/** Replay a single case's request against `target` and capture the result. */
export async function replayCase(target: ReplayTarget, parityCase: ParityCase): Promise<ReplayResult> {
  const { status, headers, rawBody } = await performRequest(target, parityCase.request);
  const contentType = String(headers['content-type'] ?? '');
  if (contentType.includes('event-stream') || parityCase.expectedStream) {
    return { status, headers, streamEvents: parseSse(rawBody) };
  }
  let body: unknown = rawBody;
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  }
  return { status, headers, body };
}

/**
 * Compare a captured result against the case's recorded expectation. The live
 * result is scrubbed into fixture space and normalized before diffing.
 */
export function compareCase(
  parityCase: ParityCase,
  result: ReplayResult,
  config: NormalizerConfig = DEFAULT_NORMALIZERS,
): CaseParity {
  const diffs: Diff[] = [];

  if (parityCase.expectedResponse) {
    const expected = parityCase.expectedResponse;
    if (expected.status !== result.status) {
      diffs.push({ path: '$.status', kind: 'changed', expected: expected.status, actual: result.status });
    }
    const expectedHeaders = normalizeHeaders(expected.headers, config);
    const actualHeaders = normalizeHeaders(scrubHeaders(result.headers), config);
    diffs.push(...diffValues(expectedHeaders, actualHeaders, '$.headers'));

    const expectedBody = normalizeValue(expected.body, config);
    const actualBody = normalizeValue(scrubValue(result.body), config);
    diffs.push(...diffValues(expectedBody, actualBody, '$.body'));
  }

  if (parityCase.expectedStream) {
    const expectedEvents = normalizeValue(parityCase.expectedStream, config);
    const actualEvents = normalizeValue(
      (result.streamEvents ?? []).map((e) => ({ event: e.event, data: scrubValue(e.data) })),
      config,
    );
    diffs.push(...diffValues(expectedEvents, actualEvents, '$.stream'));
  }

  return { case: parityCase.name, ok: diffs.length === 0, diffs };
}

/** Adapt a corpus case read from disk into a parity case. */
export function fromCorpusCase(corpusCase: CorpusCase): ParityCase {
  return {
    name: `${corpusCase.provider}/${corpusCase.name}`,
    request: {
      method: corpusCase.request.method,
      url: corpusCase.request.url,
      headers: corpusCase.request.headers,
      body: corpusCase.request.body,
    },
    expectedResponse: corpusCase.response,
    expectedStream: corpusCase.streamEvents,
  };
}

/** Replay every case against `target`, comparing each, and return a parity report. */
export async function runParity(
  target: ReplayTarget,
  cases: ParityCase[],
  config: NormalizerConfig = DEFAULT_NORMALIZERS,
): Promise<ParityReport> {
  const results: CaseParity[] = [];
  for (const parityCase of cases) {
    const result = await replayCase(target, parityCase);
    results.push(compareCase(parityCase, result, config));
  }
  return summarize(target.name, results);
}
