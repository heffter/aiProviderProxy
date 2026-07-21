/**
 * Parity normalizers (epic AIPP-1, subtask 1.4).
 *
 * Before diffing a replayed response against a recorded expectation, volatile
 * fields that legitimately vary between runs are collapsed to constant tokens so
 * they do not register as parity failures:
 *   - ids (message ids, request ids, trace ids, UUIDs)
 *   - timestamps (unix or ISO)
 *   - latency/duration fields
 *   - scrubbed content placeholders (exact text is non-deterministic for LLMs)
 *
 * Everything else is preserved. In particular usage numbers and array ordering
 * are NEVER normalized, so real differences in token accounting or SSE event
 * order still surface as diffs.
 */

/** Configuration controlling which fields are collapsed. */
export interface NormalizerConfig {
  /** Object keys whose values are volatile ids. */
  idKeys: readonly string[];
  /** Object keys whose values are timestamps (numeric or string). */
  timestampKeys: readonly string[];
  /** Object keys whose values are latency/duration measurements. */
  latencyKeys: readonly string[];
  /** String values matching any of these are treated as volatile ids. */
  idValuePatterns: readonly RegExp[];
  /** Header names (lowercased) dropped entirely before diffing. */
  dropHeaderKeys: readonly string[];
  /** When true, scrubbed content placeholders collapse to {@link CONTENT_TOKEN}. */
  collapseContent: boolean;
}

export const ID_TOKEN = '<id>';
export const TIMESTAMP_TOKEN = '<timestamp>';
export const LATENCY_TOKEN = '<latency>';
export const CONTENT_TOKEN = '<content>';

/** Matches scrubbed content placeholders produced by the fixture scrubber. */
const SCRUBBED_CONTENT_RE = /^<scrubbed:\d+:[0-9a-f]{8}>$/;
const SECRET_PLACEHOLDER = '<redacted:secret>';

/** Default normalizer configuration for the proxy's response shapes. */
export const DEFAULT_NORMALIZERS: NormalizerConfig = {
  idKeys: [
    'id',
    'request_id',
    'requestId',
    'trace_id',
    'traceId',
    'x_request_id',
    'system_fingerprint',
  ],
  timestampKeys: ['created', 'created_at', 'createdAt', 'timestamp', 'time'],
  latencyKeys: [
    'latency',
    'latency_ms',
    'latencyMs',
    'duration',
    'duration_ms',
    'elapsed_ms',
    'processing_ms',
  ],
  idValuePatterns: [
    /^msg_[A-Za-z0-9]+$/,
    /^chatcmpl-[A-Za-z0-9]+$/,
    /^req_[A-Za-z0-9]+$/,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  ],
  dropHeaderKeys: [
    'date',
    'x-request-id',
    'request-id',
    'x-relay-trace-id',
    'cf-ray',
    'set-cookie',
    'age',
    'server-timing',
    'content-length',
  ],
  collapseContent: true,
};

function isScrubbedContent(value: string): boolean {
  return value === SECRET_PLACEHOLDER || SCRUBBED_CONTENT_RE.test(value);
}

/**
 * Recursively normalize a JSON value. `key` is the object key the value was
 * found under, which drives the id/timestamp/latency collapsing.
 */
export function normalizeValue(
  value: unknown,
  config: NormalizerConfig,
  key?: string,
): unknown {
  // Key-driven collapsing takes precedence over type, so a numeric `created`
  // timestamp is collapsed rather than preserved as a usage-style number.
  if (key !== undefined) {
    if (config.timestampKeys.includes(key)) {
      return TIMESTAMP_TOKEN;
    }
    if (config.idKeys.includes(key)) {
      return ID_TOKEN;
    }
    if (config.latencyKeys.includes(key)) {
      return LATENCY_TOKEN;
    }
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value; // usage numbers, indices, flags preserved
  }
  if (typeof value === 'string') {
    if (config.collapseContent && isScrubbedContent(value)) {
      return CONTENT_TOKEN;
    }
    if (config.idValuePatterns.some((re) => re.test(value))) {
      return ID_TOKEN;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, config, key)); // order preserved
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[childKey] = normalizeValue(childValue, config, childKey);
    }
    return out;
  }
  return value;
}

/** Drop volatile headers and lowercase names for a stable comparison. */
export function normalizeHeaders(
  headers: Record<string, string> | undefined,
  config: NormalizerConfig = DEFAULT_NORMALIZERS,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (config.dropHeaderKeys.includes(lower)) {
      continue;
    }
    out[lower] = value;
  }
  return out;
}
