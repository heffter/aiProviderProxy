/**
 * Fixture corpus layout, tap API, and linter (epic AIPP-1, subtask 1.3).
 *
 * The committed corpus lives at
 *   test/fixtures/{anthropic,openai-chat,gemini,ollama}/<case>/
 * with up to three files per case:
 *   - request.json  scrubbed request  ({ method, url, headers, body })
 *   - response.json scrubbed unary response ({ status, headers, body })
 *   - stream.jsonl  one scrubbed SSE event per line ({ event, data })
 *
 * A case is unary (request.json + response.json) or streaming
 * (request.json + stream.jsonl). Provider is implied by the parent directory;
 * route by the request url; streaming by the presence of stream.jsonl -- so no
 * fourth metadata file is needed.
 *
 * {@link recordCorpusCase} is the tap the legacy proxy would call to append a
 * real capture; it scrubs via {@link module:recorder}/{@link module:scrubber}
 * and is a no-op when recording is disabled. {@link lintCorpus} validates that
 * every committed case is structurally complete and fully scrubbed.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  buildFixture,
  getFixtureDir,
  type Fixture,
  type RawCapture,
} from './recorder.js';
import {
  collectContentLeaks,
  containsSecret,
  HEADER_ALLOWLIST,
} from './scrubber.js';

/**
 * The corpus directories.
 *
 * `anthropic`, `openai-chat`, `gemini` and `ollama` date from the legacy-parity
 * corpus, where a directory named the upstream provider. `openai-responses` was
 * added with the gateway tap (subtask 1.3), which records client surfaces
 * instead -- there is no Responses *provider*, but there is a Responses
 * surface. The older names are kept so the existing cases stay valid.
 */
export const PROVIDER_DIRS = [
  'anthropic',
  'openai-chat',
  'openai-responses',
  'gemini',
  'ollama',
] as const;
export type ProviderDir = (typeof PROVIDER_DIRS)[number];

const REQUEST_FILE = 'request.json';
const RESPONSE_FILE = 'response.json';
const STREAM_FILE = 'stream.jsonl';

/** A parsed corpus case read back from disk. */
export interface CorpusCase {
  provider: string;
  name: string;
  dir: string;
  request: Fixture['request'];
  response: Fixture['response'];
  streamEvents: Fixture['streamEvents'];
}

/** Result of linting a single case. `ok` is true only when `errors` is empty. */
export interface LintResult {
  case: string;
  ok: boolean;
  errors: string[];
}

/** Aggregate lint result across a corpus tree. */
export interface CorpusLintReport {
  totalCases: number;
  okCases: number;
  results: LintResult[];
  byProvider: Record<string, number>;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Scrub `raw` and write it as a corpus case directory under `baseDir`. Returns
 * the case directory path. Pure IO -- always writes regardless of the record
 * env flag (used by tests and by {@link recordCorpusCase}).
 */
export function writeCorpusCase(
  baseDir: string,
  provider: string,
  caseName: string,
  raw: RawCapture,
): string {
  const fixture = buildFixture(raw);
  const caseDir = join(baseDir, provider, caseName);
  mkdirSync(caseDir, { recursive: true });

  writeJson(join(caseDir, REQUEST_FILE), fixture.request);
  if (fixture.response) {
    writeJson(join(caseDir, RESPONSE_FILE), fixture.response);
  }
  if (fixture.streamEvents) {
    const lines = fixture.streamEvents.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(join(caseDir, STREAM_FILE), `${lines}\n`, 'utf8');
  }
  return caseDir;
}

/**
 * The proxy-side tap: scrub and append a captured interaction to the corpus.
 * No-op returning null when recording is disabled (the default), so it is safe
 * to call from the live proxy path.
 *
 * @param raw      captured interaction
 * @param provider corpus provider directory (see {@link PROVIDER_DIRS})
 * @param caseName case directory name
 * @param baseDir  corpus root; defaults to {@link getFixtureDir}
 */
export function recordCorpusCase(
  raw: RawCapture,
  provider: string,
  caseName: string,
  baseDir: string | null = getFixtureDir(),
): string | null {
  if (!baseDir) {
    return null;
  }
  return writeCorpusCase(baseDir, provider, caseName, raw);
}

/**
 * One-call tap for the live proxy: scrub `raw` and append it to the corpus under
 * an auto-generated, content-derived case name. No-op returning null when
 * recording is disabled, so it is safe to call unconditionally from a hot path
 * (callers should still guard with {@link isRecordingEnabled} to skip building
 * the capture object entirely). Errors are the caller's to swallow.
 */
export function recordExchange(
  raw: RawCapture,
  provider: string,
  baseDir: string | null = getFixtureDir(),
): string | null {
  if (!baseDir) {
    return null;
  }
  const fixture = buildFixture(raw);
  const kind = fixture.streamEvents ? 'stream' : 'unary';
  const hash = createHash('sha256')
    .update(JSON.stringify(fixture))
    .digest('hex')
    .slice(0, 10);
  return writeCorpusCase(baseDir, provider, `${kind}-${hash}`, raw);
}

/** Read a single corpus case directory back into memory. */
export function readCorpusCase(provider: string, caseDir: string): CorpusCase {
  const requestPath = join(caseDir, REQUEST_FILE);
  const request = JSON.parse(
    readFileSync(requestPath, 'utf8'),
  ) as Fixture['request'];

  let response: Fixture['response'] = null;
  const responsePath = join(caseDir, RESPONSE_FILE);
  if (existsSync(responsePath)) {
    response = JSON.parse(readFileSync(responsePath, 'utf8')) as NonNullable<
      Fixture['response']
    >;
  }

  let streamEvents: Fixture['streamEvents'] = null;
  const streamPath = join(caseDir, STREAM_FILE);
  if (existsSync(streamPath)) {
    streamEvents = readFileSync(streamPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event: string; data: unknown });
  }

  return {
    provider,
    name: caseDir.split(/[\\/]/).pop() ?? caseDir,
    dir: caseDir,
    request,
    response,
    streamEvents,
  };
}

function lintHeaders(
  where: string,
  headers: Record<string, string>,
  errors: string[],
): void {
  for (const name of Object.keys(headers)) {
    if (!HEADER_ALLOWLIST.has(name.toLowerCase())) {
      errors.push(`${where}: non-allowlisted header "${name}"`);
    }
  }
}

function lintScrub(where: string, value: unknown, errors: string[]): void {
  if (containsSecret(JSON.stringify(value))) {
    errors.push(`${where}: secret pattern detected`);
  }
  const leaks = collectContentLeaks(value);
  if (leaks.length > 0) {
    errors.push(
      `${where}: ${leaks.length} unscrubbed content string(s), e.g. ${JSON.stringify(leaks[0]).slice(0, 60)}`,
    );
  }
}

/**
 * Validate one case directory: structural completeness, header allowlisting,
 * and full scrubbing (no secrets, no unscrubbed content).
 */
export function lintCorpusCase(provider: string, caseDir: string): LintResult {
  const name = `${provider}/${caseDir.split(/[\\/]/).pop() ?? caseDir}`;
  const errors: string[] = [];

  if (!existsSync(join(caseDir, REQUEST_FILE))) {
    errors.push(`${name}: missing ${REQUEST_FILE}`);
    return { case: name, ok: false, errors };
  }
  const hasResponse = existsSync(join(caseDir, RESPONSE_FILE));
  const hasStream = existsSync(join(caseDir, STREAM_FILE));
  if (!hasResponse && !hasStream) {
    errors.push(
      `${name}: case has neither ${RESPONSE_FILE} nor ${STREAM_FILE}`,
    );
  }

  let parsed: CorpusCase;
  try {
    parsed = readCorpusCase(provider, caseDir);
  } catch (err) {
    errors.push(`${name}: unparseable fixture (${(err as Error).message})`);
    return { case: name, ok: false, errors };
  }

  const request = parsed.request;
  if (
    !request ||
    typeof request.method !== 'string' ||
    typeof request.url !== 'string' ||
    !request.headers
  ) {
    errors.push(`${name}: request is missing method/url/headers`);
  } else {
    lintHeaders(`${name}/request.headers`, request.headers, errors);
    lintScrub(`${name}/request.body`, request.body, errors);
  }

  if (parsed.response) {
    if (typeof parsed.response.status !== 'number') {
      errors.push(`${name}: response is missing a numeric status`);
    }
    lintHeaders(`${name}/response.headers`, parsed.response.headers, errors);
    lintScrub(`${name}/response.body`, parsed.response.body, errors);
  }
  if (parsed.streamEvents) {
    parsed.streamEvents.forEach((event, i) => {
      if (typeof event.event !== 'string') {
        errors.push(`${name}: stream event ${i} missing "event"`);
      }
      lintScrub(`${name}/stream[${i}].data`, event.data, errors);
    });
  }

  return { case: name, ok: errors.length === 0, errors };
}

function listCaseDirs(providerDir: string): string[] {
  if (!existsSync(providerDir)) {
    return [];
  }
  return readdirSync(providerDir)
    .map((entry) => join(providerDir, entry))
    .filter((p) => statSync(p).isDirectory());
}

/** Lint every case under a corpus root, returning an aggregate report. */
export function lintCorpus(baseDir: string): CorpusLintReport {
  const results: LintResult[] = [];
  const byProvider: Record<string, number> = {};

  for (const provider of PROVIDER_DIRS) {
    const providerDir = join(baseDir, provider);
    const caseDirs = listCaseDirs(providerDir);
    byProvider[provider] = caseDirs.length;
    for (const caseDir of caseDirs) {
      results.push(lintCorpusCase(provider, caseDir));
    }
  }

  return {
    totalCases: results.length,
    okCases: results.filter((r) => r.ok).length,
    results,
    byProvider,
  };
}
