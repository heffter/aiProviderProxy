/**
 * Client-side fixture recording tap for the gateway (epic AIPP-1, subtask 1.3).
 *
 * The original corpus tap lived in the legacy proxy (`src/standalone-proxy.ts`),
 * which the greenfield rewrite removed; its only call site went with it, leaving
 * {@link module:corpus.recordExchange} orphaned. This module is the replacement,
 * and it records a different thing on purpose: the legacy corpus was a *parity*
 * baseline to diff a new stack against an old one, and there is no longer an old
 * stack. What is still worth freezing is the gateway's own client-facing
 * behaviour, as a *regression* corpus.
 *
 * The tap sits at the HTTP boundary, between `handle()` and `writeResponse()`,
 * because that is the only place where both sides of the client exchange are in
 * hand. Capturing further in would record the upstream view instead -- which for
 * a translated route is a different protocol from the one the client spoke, and
 * so cannot be replayed against the surface it came from.
 *
 * Two invariants hold regardless of configuration:
 *
 *   - **Opt-in.** With `AIPP_RECORD_FIXTURES` unset, {@link tapExchange} returns
 *     the very same response object it was given. No wrapping, no allocation,
 *     no parsing.
 *   - **Behaviour-neutral.** Every chunk reaches the client unchanged and in
 *     order, recording is capped so a long stream cannot grow memory without
 *     bound, and every recording path is wrapped so a failure to record can
 *     never fail or alter a response. Recording costs one synchronous frame
 *     split per chunk; it never performs IO on the streaming path.
 */

import { SseFrameSplitter } from '../gateway/sse.js';
import { writeCorpusCase } from './corpus.js';
import {
  getFixtureDir,
  type RawCapture,
  type RawStreamEvent,
} from './recorder.js';

/**
 * Stop collecting stream events past this many. A recorded fixture is meant to
 * be a readable, replayable case; a 10,000-event transcript is neither, and
 * holding one in memory to record it would be exactly the behavioural impact
 * this tap promises not to have. Pass-through is never capped.
 */
export const MAX_RECORDED_EVENTS = 2000;

/**
 * The request fields the tap needs. Declared structurally rather than imported
 * from the gateway so that `server.ts` can import this module without a cycle.
 */
export interface TappableRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** The response fields the tap needs. Structural, for the same reason. */
export interface TappableResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  stream?: AsyncIterable<string>;
}

/**
 * Map a client surface to its corpus directory, or null for a route that is not
 * part of the corpus (health, dashboard, control endpoints).
 *
 * The directory names a *client surface*, not an upstream provider. That is the
 * regression framing: a case answers "what does this surface return for this
 * request", which is replayable; the upstream that served it is recorded in
 * `meta.routedModel` instead of the path.
 */
export function corpusDirForUrl(url: string): string | null {
  const path = url.split('?')[0];
  if (path === '/v1/messages' || path === '/v1/messages/count_tokens') {
    return 'anthropic';
  }
  if (path === '/v1/chat/completions') {
    return 'openai-chat';
  }
  if (path === '/v1/responses') {
    return 'openai-responses';
  }
  return null;
}

/** Parse a request body, tolerating a missing or malformed one. */
function parseBody(body: string): Record<string, unknown> {
  if (!body) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Filesystem-safe slug for a model id. */
function modelSlug(body: Record<string, unknown>): string {
  const model = typeof body.model === 'string' ? body.model : 'unknown-model';
  return model.replace(/[^A-Za-z0-9.-]+/g, '-').toLowerCase();
}

/**
 * The feature a case exercises, used as its directory name so the committed
 * corpus reads as a coverage matrix rather than a pile of hashes.
 */
function featureOf(
  url: string,
  body: Record<string, unknown>,
  status: number,
): string {
  if (status >= 400) {
    return `error-${status}`;
  }
  if (url.split('?')[0] === '/v1/messages/count_tokens') {
    return 'count-tokens';
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return 'tools';
  }
  const thinking = body.thinking as { type?: string } | undefined;
  if (thinking && thinking.type && thinking.type !== 'disabled') {
    return 'extended-thinking';
  }
  if (body.system !== undefined) {
    return 'system-blocks';
  }
  if (body.cache_control !== undefined) {
    return 'prompt-caching-cache-control';
  }
  return 'plain-text';
}

/**
 * Case directory name. Streaming cases carry a `-stream` suffix: the on-disk
 * format distinguishes unary from streaming by which files are present, so a
 * shared name would land `response.json` and `stream.jsonl` in one directory
 * and make the case ambiguous.
 */
export function caseNameFor(
  url: string,
  requestBody: string,
  status: number,
  streaming: boolean,
): string {
  const body = parseBody(requestBody);
  const name = `${modelSlug(body)}-${featureOf(url, body, status)}`;
  return streaming ? `${name}-stream` : name;
}

/**
 * Parse one SSE block into a recordable event.
 *
 * Anthropic frames carry an explicit `event:` line; OpenAI-style frames carry
 * only `data:`, so they are recorded under the SSE default event name
 * (`message`) rather than dropped -- the corpus linter requires `event` to be a
 * string. `data: [DONE]` has no JSON to parse and is kept verbatim.
 */
export function parseSseFrame(frame: string): RawStreamEvent | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  if (raw !== '[DONE]') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw; // keep the payload rather than dropping the event
    }
  }
  return { event: event ?? 'message', data };
}

/** Build the raw capture for a completed exchange. */
function buildCapture(
  request: TappableRequest,
  response: TappableResponse,
  streamEvents: RawStreamEvent[] | null,
  truncated: boolean,
): RawCapture {
  const path = request.url.split('?')[0];
  const meta: Record<string, unknown> = {
    capturedFrom: 'aiproviderproxy gateway',
    surface: path,
  };
  if (truncated) {
    meta.truncated = true;
  }
  return {
    route: path,
    request: {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: parseBody(request.body),
    },
    // A streaming case records the event sequence instead of a unary body: the
    // body is empty for a streamed response, and writing both would produce a
    // case the reader cannot classify.
    response: streamEvents
      ? undefined
      : {
          status: response.status,
          headers: response.headers,
          body: parseBody(response.body),
        },
    streamEvents: streamEvents ?? undefined,
    meta,
  };
}

/** Write a case, swallowing any failure. Recording must never break a response. */
function safeWrite(
  baseDir: string,
  dir: string,
  caseName: string,
  raw: RawCapture,
): void {
  try {
    writeCorpusCase(baseDir, dir, caseName, raw);
  } catch {
    // A full disk or a read-only corpus directory is not a reason to fail a
    // request the client is already receiving.
  }
}

/**
 * Wrap a streamed response so the client sees every chunk unchanged while the
 * event sequence is recorded alongside it.
 *
 * Each chunk is parsed and then yielded unchanged (see the ordering note in the
 * loop). Recording performs no IO on the streaming path -- the single write
 * happens once, at completion. The `finally` runs even when the client hangs up
 * mid-stream, which is what makes a truncated stream recordable rather than
 * lost.
 */
function tapStream(
  source: AsyncIterable<string>,
  onComplete: (events: RawStreamEvent[], truncated: boolean) => void,
): AsyncIterable<string> {
  return (async function* tapped(): AsyncIterable<string> {
    const splitter = new SseFrameSplitter();
    const events: RawStreamEvent[] = [];
    let truncated = false;

    const collect = (frames: string[]): void => {
      for (const frame of frames) {
        if (events.length >= MAX_RECORDED_EVENTS) {
          truncated = true;
          return;
        }
        const parsed = parseSseFrame(frame);
        if (parsed) {
          events.push(parsed);
        }
      }
    };

    try {
      for await (const chunk of source) {
        // Parse before yielding, not after. Yielding first reads as the
        // lower-latency order, but a consumer that abandons the iterator (the
        // client hung up) never resumes the generator, so the post-yield parse
        // never runs and the last chunk the gateway produced is missing from
        // the fixture -- which is exactly the chunk a truncated-stream case
        // exists to capture. The cost paid for correctness is a synchronous
        // split on one small frame, which is not measurable against the network
        // it is racing.
        try {
          collect(splitter.push(chunk));
        } catch {
          // Malformed frame: keep streaming, record what we have.
        }
        yield chunk;
      }
      try {
        collect(splitter.flush());
      } catch {
        /* as above */
      }
    } finally {
      try {
        onComplete(events, truncated);
      } catch {
        /* recording must not surface into the response path */
      }
    }
  })();
}

/**
 * Record a client exchange into the fixture corpus, returning the response to
 * hand to the client.
 *
 * Returns the *same object* when recording is disabled or the route is not part
 * of the corpus, so the default path is untouched.
 *
 * @param request  the inbound client request
 * @param response the gateway's response, buffered or streamed
 * @param baseDir  corpus root; defaults to {@link getFixtureDir}
 */
export function tapExchange(
  request: TappableRequest,
  response: TappableResponse,
  baseDir: string | null = getFixtureDir(),
): TappableResponse {
  if (!baseDir) {
    return response;
  }
  let dir: string | null;
  try {
    dir = corpusDirForUrl(request.url);
  } catch {
    return response;
  }
  if (!dir) {
    return response;
  }

  if (!response.stream) {
    const caseName = caseNameFor(
      request.url,
      request.body,
      response.status,
      false,
    );
    safeWrite(
      baseDir,
      dir,
      caseName,
      buildCapture(request, response, null, false),
    );
    return response;
  }

  const caseName = caseNameFor(
    request.url,
    request.body,
    response.status,
    true,
  );
  return {
    ...response,
    stream: tapStream(response.stream, (events, truncated) => {
      if (events.length === 0) {
        return; // nothing observed (immediate disconnect); no case worth writing
      }
      safeWrite(
        baseDir,
        dir,
        caseName,
        buildCapture(request, response, events, truncated),
      );
    }),
  };
}
