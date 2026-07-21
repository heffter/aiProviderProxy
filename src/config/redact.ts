/**
 * Central redaction utility (epic AIPP-2, subtask 2.4; FR-CONFIG-006, FR-AUTH-004).
 *
 * The single place that turns config, headers, errors, and arbitrary diagnostic
 * objects into secret-free output. Redaction happens two ways:
 * - by value: known credential shapes (sk-ant-, sk-, Bearer tokens, Google/xAI/
 *   Groq/AWS keys) are replaced wherever they appear in a string;
 * - by key: values under sensitive keys (accessToken, apiKey, authorization,
 *   x-api-key, cookie, credential, password, ...) are dropped entirely.
 *
 * `logger`, the error formatter, `aipp config show`, and DLQ writes must route
 * output through here; an ESLint rule flags direct `JSON.stringify(config)` /
 * `JSON.stringify(headers)` to steer callers to {@link safeStringify}.
 */

/** Replacement for a value dropped by key. */
export const REDACTED = '<redacted>';

/** Replacement for a secret matched by pattern inside a string. */
export const REDACTED_SECRET = '<redacted:secret>';

/** Prefix-anchored credential patterns. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-(?:ant|or|proj|live|test|svcacct)-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /xai-[A-Za-z0-9]{16,}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

/** Keys whose values are dropped regardless of content. */
const SENSITIVE_KEY_RE =
  /(?:access[_-]?token|api[_-]?key|secret|password|passwd|authorization|cookie|bearer|credentials?|private[_-]?key|session[_-]?token|x-api-key)/i;

/** Replace every credential-shaped substring in `input`. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED_SECRET);
  }
  return out;
}

/** True if a value under `key` should be dropped wholesale. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/**
 * Recursively redact a value. Values under a sensitive key are dropped (unless
 * null/undefined, which are kept so "not set" stays distinguishable); strings
 * are pattern-redacted; numbers/booleans and structure are preserved. Idempotent:
 * `redactValue(redactValue(x))` deep-equals `redactValue(x)`.
 */
export function redactValue(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (key !== undefined && isSensitiveKey(key)) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return value;
}

/** Redact then JSON-stringify a value for safe logging/diagnostics. */
export function safeStringify(
  value: unknown,
  space: number | undefined = 2,
): string {
  return JSON.stringify(redactValue(value), null, space);
}

/** Redact an error's message for safe display. */
export function redactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactString(message);
}

/**
 * Allowlist-based diagnostic serializer: return an object containing only the
 * allowlisted top-level keys, each redacted. Everything not allowlisted is
 * omitted entirely.
 */
export function serializeForDiagnostics(
  value: Record<string, unknown>,
  allowlist: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowlist) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      out[key] = redactValue(value[key], key);
    }
  }
  return out;
}
