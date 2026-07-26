/**
 * Request resource limits (epic AIPP-12, subtask 12.5; NFR-SEC-008).
 *
 * Cheap, allocation-free guards against two request-side denial-of-service
 * vectors: an oversized body (memory / parse cost) and pathologically deep JSON
 * nesting (recursion / stack cost in downstream processing). Both are checked on
 * the raw body string before any JSON.parse, so a hostile request is rejected
 * before it can consume real work.
 */

/** Default maximum request body size (10 MiB). */
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

/** Default maximum JSON nesting depth. */
export const MAX_JSON_DEPTH = 64;

/** Configurable limit policy. */
export interface LimitPolicy {
  maxBytes?: number;
  maxDepth?: number;
}

/** Result of a limit check. */
export interface LimitCheck {
  ok: boolean;
  reason?: string;
}

/**
 * The maximum `{`/`[` nesting depth in a JSON string, ignoring brackets that
 * appear inside string literals (with escape handling). O(n), no allocation.
 */
export function jsonNestingDepth(body: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > max) {
        max = depth;
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
  }
  return max;
}

/**
 * Check a raw request body against the size and depth limits. Returns
 * `{ ok: true }` when safe, or `{ ok: false, reason }` describing the breach.
 */
export function checkRequestLimits(
  body: string,
  policy: LimitPolicy = {},
): LimitCheck {
  const maxBytes = policy.maxBytes ?? MAX_REQUEST_BYTES;
  const maxDepth = policy.maxDepth ?? MAX_JSON_DEPTH;
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    return { ok: false, reason: `request body exceeds ${maxBytes} bytes` };
  }
  if (jsonNestingDepth(body) > maxDepth) {
    return { ok: false, reason: `request JSON nesting exceeds ${maxDepth}` };
  }
  return { ok: true };
}
