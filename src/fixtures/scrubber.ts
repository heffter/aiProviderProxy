/**
 * Fixture content scrubber (epic AIPP-1, subtask 1.2).
 *
 * Removes prompt/response text and secrets from captured proxy traffic while
 * preserving the structure a parity harness needs: block types, roles, model
 * ids, tool schemas, SSE event ordering, and all usage numbers.
 *
 * Design:
 * - Numbers and booleans are preserved verbatim (usage counters, flags, indices).
 * - Object keys and array ordering are preserved (structure).
 * - String values are replaced with deterministic placeholders EXCEPT when the
 *   key is an enum/identifier (see {@link STRUCTURAL_STRING_KEYS}) or the value
 *   lives inside a schema region (see {@link PRESERVE_STRUCTURE_KEYS}).
 * - Every surviving string is additionally run through {@link redactSecrets} so
 *   no credential can leak even through a preserved field.
 * - HTTP headers are dropped unless explicitly allowlisted; auth headers never
 *   survive.
 *
 * The placeholder is derived from a truncated SHA-256 of the (already
 * secret-redacted) value, so identical content scrubs to an identical
 * placeholder without any reversible content or secret material surviving.
 */

import { createHash } from 'node:crypto';

/** Marker used for any substring that matched a secret pattern. */
export const SECRET_PLACEHOLDER = '<redacted:secret>';

/**
 * Request/response header names (lowercased) preserved in fixtures. Everything
 * else -- authorization, x-api-key, cookie, provider-specific auth headers -- is
 * dropped entirely rather than scrubbed.
 */
export const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'content-type',
  'accept',
  'accept-encoding',
  'anthropic-version',
  'anthropic-beta',
  'user-agent',
]);

/**
 * JSON string-valued keys whose values are enums or identifiers (not user
 * content) and are therefore preserved verbatim (after secret redaction).
 */
export const STRUCTURAL_STRING_KEYS: ReadonlySet<string> = new Set([
  'type',
  'role',
  'model',
  'provider',
  'stop_reason',
  'finish_reason',
  'event',
  'object',
  'name',
]);

/**
 * Keys whose entire subtree is a schema/definition region rather than
 * conversation content. Strings inside are preserved (secret-redacted) so tool
 * schemas survive replay intact.
 */
export const PRESERVE_STRUCTURE_KEYS: ReadonlySet<string> = new Set([
  'tools',
  'functions',
  'input_schema',
  'parameters',
  'tool_choice',
  'response_format',
]);

/**
 * Prefix-anchored secret patterns. Anchoring to known key prefixes avoids false
 * positives on structural data (model ids, enums) while still catching every
 * credential family the proxy handles.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-(?:ant|or|proj|live|test|svcacct)-[A-Za-z0-9_-]{8,}/g, // prefixed sk- variants (incl. hyphens)
  /sk-[A-Za-z0-9]{16,}/g, // bare OpenAI-style keys
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, // Authorization bearer tokens
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /xai-[A-Za-z0-9]{16,}/g, // xAI keys
  /gsk_[A-Za-z0-9]{20,}/g, // Groq keys
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
];

/** Replace every secret-looking substring in `value` with {@link SECRET_PLACEHOLDER}. */
export function redactSecrets(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, SECRET_PLACEHOLDER);
  }
  return out;
}

/** True if `value` contains at least one secret-looking substring. */
export function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

/**
 * Replace free-text content with a deterministic, non-reversible placeholder.
 * Secrets are stripped before hashing so no secret material feeds the hash.
 */
export function scrubText(value: string): string {
  const deSecreted = redactSecrets(value);
  if (deSecreted.length === 0) {
    return '';
  }
  const hash = createHash('sha256')
    .update(deSecreted)
    .digest('hex')
    .slice(0, 8);
  return `<scrubbed:${deSecreted.length}:${hash}>`;
}

/**
 * Recursively scrub a JSON value.
 *
 * @param value   the value to scrub
 * @param key     the object key this value was found under (drives enum preservation)
 * @param preserve when true, the value is inside a schema region: strings are
 *                 kept verbatim (secret-redacted) instead of being placeholdered
 */
export function scrubValue(
  value: unknown,
  key?: string,
  preserve = false,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value; // preserve usage numbers, indices, flags
  }
  if (typeof value === 'string') {
    const deSecreted = redactSecrets(value);
    if (preserve || (key !== undefined && STRUCTURAL_STRING_KEYS.has(key))) {
      return deSecreted;
    }
    return scrubText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, key, preserve)); // preserve ordering
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const childPreserve = preserve || PRESERVE_STRUCTURE_KEYS.has(childKey);
      out[childKey] = scrubValue(childValue, childKey, childPreserve); // preserve keys
    }
    return out;
  }
  return value;
}

/** Convenience wrapper: scrub a top-level JSON value. */
export function scrubJson(value: unknown): unknown {
  return scrubValue(value, undefined, false);
}

/** Shape of a placeholder emitted by {@link scrubText}. */
const CONTENT_PLACEHOLDER_RE = /^<scrubbed:\d+:[0-9a-f]{8}>$/;

/**
 * True if `value` is an already-scrubbed content string: an empty string, the
 * secret marker, or a `<scrubbed:len:hash>` placeholder. Used by the corpus
 * linter to prove content-position strings carry no raw text.
 */
export function isScrubbedPlaceholder(value: string): boolean {
  return (
    value === '' ||
    value === SECRET_PLACEHOLDER ||
    CONTENT_PLACEHOLDER_RE.test(value)
  );
}

/**
 * Walk a JSON value the same way {@link scrubValue} does and collect every
 * content-position string (i.e. not a structural enum and not inside a schema
 * region) that is NOT an already-scrubbed placeholder. An empty result means
 * the value carries no unscrubbed content.
 */
export function collectContentLeaks(
  value: unknown,
  key?: string,
  preserve = false,
  out: string[] = [],
): string[] {
  if (typeof value === 'string') {
    const isStructural = key !== undefined && STRUCTURAL_STRING_KEYS.has(key);
    if (!preserve && !isStructural && !isScrubbedPlaceholder(value)) {
      out.push(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectContentLeaks(item, key, preserve, out);
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      collectContentLeaks(
        childValue,
        childKey,
        preserve || PRESERVE_STRUCTURE_KEYS.has(childKey),
        out,
      );
    }
  }
  return out;
}

/**
 * Return a new headers object containing only allowlisted headers, with values
 * secret-redacted. Header names are lowercased; array values are joined.
 */
export function scrubHeaders(
  headers: Record<string, string | string[] | number | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const name = rawKey.toLowerCase();
    if (!HEADER_ALLOWLIST.has(name) || rawValue === undefined) {
      continue;
    }
    const value = Array.isArray(rawValue)
      ? rawValue.join(', ')
      : String(rawValue);
    out[name] = redactSecrets(value);
  }
  return out;
}
