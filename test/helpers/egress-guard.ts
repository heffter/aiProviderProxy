/**
 * Egress-allowlist harness (epic AIPP-12, subtask 12.4; NFR-SEC-009,
 * FR-IDENT-004).
 *
 * Installs a global fetch interceptor that records every outbound hostname and
 * flags any that is not on the allowlist, then restores the original fetch. No
 * request actually leaves the machine while the guard is installed. This is the
 * executable proof that all first-party phone-home behavior is gone and stays
 * gone; a rogue fetch to any other host shows up in `violations`.
 */

export interface EgressResult<T> {
  result: T;
  /** Hostnames contacted that are NOT on the allowlist. */
  violations: string[];
  /** Every hostname contacted (for diagnostics). */
  calls: string[];
}

function targetUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const req = input as { url?: string };
  return typeof req?.url === 'string' ? req.url : '';
}

/**
 * Run `fn` with a fetch interceptor installed. Any hostname outside `allowHosts`
 * is recorded as a violation; fetch resolves to an inert stub so nothing leaves
 * the machine.
 */
export async function withEgressGuard<T>(
  allowHosts: readonly string[],
  fn: () => Promise<T> | T,
): Promise<EgressResult<T>> {
  const allow = new Set(allowHosts.map((h) => h.toLowerCase()));
  const violations: string[] = [];
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    let host = '';
    try {
      host = new URL(targetUrl(input)).hostname.toLowerCase();
    } catch {
      host = '<invalid-url>';
    }
    calls.push(host);
    if (!allow.has(host)) {
      violations.push(host);
    }
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  try {
    const result = await fn();
    return { result, violations, calls };
  } finally {
    globalThis.fetch = original;
  }
}
