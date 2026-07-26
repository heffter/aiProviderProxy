/**
 * SSRF base-URL validation (epic AIPP-12, subtask 12.2; NFR-SEC-003/004).
 *
 * A configured provider base URL is a request destination the gateway will send
 * credentials to, so it is validated at config load: https is required, embedded
 * credentials are rejected, non-http(s) schemes are rejected, and private or
 * loopback destinations require an explicit per-provider opt-in
 * (`allowPrivateNetwork`) -- the guard against pointing a provider at an
 * internal service (169.254.x metadata, 10.x, localhost, ...).
 */

/** Thrown for a base URL that fails validation. */
export class BaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaseUrlError';
  }
}

/** Validation policy for a base URL. */
export interface BaseUrlPolicy {
  /** Permit http and private/loopback destinations (default false). */
  allowPrivateNetwork?: boolean;
}

/** True when a hostname is loopback, link-local, or an RFC-1918 private range. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  // IPv6 unique-local / link-local.
  if (
    host.startsWith('fd') ||
    host.startsWith('fc') ||
    host.startsWith('fe80')
  ) {
    return true;
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) {
    return false;
  }
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private / this-host
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  return false;
}

/**
 * Validate a provider base URL against {@link BaseUrlPolicy}. Throws
 * {@link BaseUrlError} on any violation; returns normally when the URL is safe.
 */
export function validateBaseUrl(raw: string, policy: BaseUrlPolicy = {}): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BaseUrlError(`base URL is not a valid URL: "${raw}"`);
  }
  if (url.username || url.password) {
    throw new BaseUrlError('base URL must not embed credentials (user:pass@)');
  }
  const scheme = url.protocol.replace(':', '');
  if (scheme !== 'https' && scheme !== 'http') {
    throw new BaseUrlError(
      `base URL scheme "${scheme}" is not allowed (use https)`,
    );
  }
  const priv = isPrivateHost(url.hostname);
  if (!policy.allowPrivateNetwork) {
    if (scheme !== 'https') {
      throw new BaseUrlError('base URL must use https');
    }
    if (priv) {
      throw new BaseUrlError(
        `base URL host "${url.hostname}" is private/loopback; ` +
          'set providers.<id>.allowPrivateNetwork to opt in',
      );
    }
  } else if (scheme === 'http' && !priv) {
    // http is only tolerated (under opt-in) for a private/loopback destination.
    throw new BaseUrlError('http base URLs are only allowed for private hosts');
  }
}
