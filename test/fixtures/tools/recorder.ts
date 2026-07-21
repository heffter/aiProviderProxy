/**
 * Fixture capture tooling (epic AIPP-1, subtask 1.2).
 *
 * Turns a raw proxied interaction (request, response, and/or SSE event stream)
 * into a scrubbed JSON fixture on disk. Recording is opt-in and behavior-neutral:
 * nothing is written unless the {@link RECORD_ENV_VAR} environment variable
 * points at a directory, so wiring {@link recordFixture} into the legacy proxy
 * (subtask 1.3) cannot change its default behavior.
 *
 * All content and secret handling is delegated to {@link module:scrubber}; this
 * module only shapes captures and performs IO.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets, scrubHeaders, scrubValue } from './scrubber.js';

/** Bumped when the on-disk fixture shape changes. */
export const FIXTURE_SCHEMA_VERSION = 1;

/** Set to a directory path to enable fixture recording. */
export const RECORD_ENV_VAR = 'AIPP_RECORD_FIXTURES';

type RawHeaders = Record<string, string | string[] | number | undefined>;

/** A captured inbound/outbound HTTP request, before scrubbing. */
export interface RawRequest {
  method: string;
  url: string;
  headers?: RawHeaders;
  body?: unknown;
}

/** A captured HTTP response, before scrubbing. */
export interface RawResponse {
  status: number;
  headers?: RawHeaders;
  body?: unknown;
}

/** A single captured SSE event, before scrubbing. */
export interface RawStreamEvent {
  event: string;
  data: unknown;
}

/** A complete captured interaction, before scrubbing. */
export interface RawCapture {
  route: string;
  provider?: string;
  request: RawRequest;
  response?: RawResponse;
  streamEvents?: RawStreamEvent[];
  usage?: unknown;
  meta?: Record<string, unknown>;
}

/** A scrubbed fixture ready to persist and replay. */
export interface Fixture {
  schemaVersion: number;
  route: string;
  provider: string | null;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown } | null;
  streamEvents: Array<{ event: string; data: unknown }> | null;
  usage: unknown;
  meta: Record<string, unknown>;
}

/** Strip any query string (which may carry a `?key=` credential) and redact secrets. */
function stripQuery(url: string): string {
  const q = url.indexOf('?');
  const path = q >= 0 ? url.slice(0, q) : url;
  return redactSecrets(path);
}

/** Build a scrubbed fixture from a raw capture. Pure -- performs no IO. */
export function buildFixture(raw: RawCapture): Fixture {
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    route: redactSecrets(raw.route),
    provider: raw.provider ?? null,
    request: {
      method: raw.request.method,
      url: stripQuery(raw.request.url),
      headers: scrubHeaders(raw.request.headers),
      body: scrubValue(raw.request.body),
    },
    response: raw.response
      ? {
          status: raw.response.status,
          headers: scrubHeaders(raw.response.headers),
          body: scrubValue(raw.response.body),
        }
      : null,
    streamEvents: raw.streamEvents
      ? raw.streamEvents.map((e) => ({ event: e.event, data: scrubValue(e.data) }))
      : null,
    usage: raw.usage !== undefined ? scrubValue(raw.usage) : null,
    meta: raw.meta ?? {},
  };
}

/** Kebab-case slug of a route path, used in fixture file names. */
function routeSlug(route: string): string {
  const slug = route
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'root';
}

/**
 * Deterministic fixture file name derived from the scrubbed content, so
 * re-recording the same interaction overwrites the same file rather than
 * accumulating duplicates.
 */
export function fixtureFileName(fixture: Fixture): string {
  const kind = fixture.streamEvents ? 'stream' : 'unary';
  const hash = createHash('sha256').update(JSON.stringify(fixture)).digest('hex').slice(0, 12);
  return `${routeSlug(fixture.route)}-${kind}-${hash}.json`;
}

/** Write a scrubbed fixture to `dir`, creating the directory if needed. Returns the file path. */
export function writeFixture(fixture: Fixture, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fixtureFileName(fixture));
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return file;
}

/** The configured fixture directory, or null when recording is disabled. */
export function getFixtureDir(): string | null {
  const dir = process.env[RECORD_ENV_VAR];
  return dir && dir.trim() ? dir : null;
}

/** True when {@link RECORD_ENV_VAR} points at a directory. */
export function isRecordingEnabled(): boolean {
  return getFixtureDir() !== null;
}

/**
 * Scrub and persist a captured interaction. No-op returning null when recording
 * is disabled (the default), which keeps this safe to call from the live proxy.
 *
 * @param raw the captured interaction
 * @param dir target directory; defaults to {@link getFixtureDir}
 * @returns the written file path, or null when recording is disabled
 */
export function recordFixture(raw: RawCapture, dir: string | null = getFixtureDir()): string | null {
  if (!dir) {
    return null;
  }
  return writeFixture(buildFixture(raw), dir);
}
