/**
 * Anthropic token pool (epic AIPP-4, subtask 4.4; port of legacy token-pool.ts).
 *
 * Rotates among multiple Anthropic credentials: skips rate-limited tokens (429
 * with Retry-After), quarantines a credential for one hour after two consecutive
 * 401s, and learns each token's RPM limit from upstream rate-limit headers to
 * proactively skip tokens near their cap. The clock is injectable via the `now`
 * parameter so the whole pool is deterministic under test.
 */

/** Explicit account from config. */
export interface PoolAccountConfig {
  apiKey: string;
  label?: string;
  priority?: number;
}

/** Runtime state for one credential. */
export interface TokenState {
  apiKey: string;
  label: string;
  priority: number;
  source: 'config' | 'auto-detect';
  rateLimitedUntil: number;
  quarantinedUntil: number;
  consecutiveAuthFailures: number;
  knownRpmLimit?: number;
  requestsThisMinute: number;
  minuteWindowStart: number;
}

const DEFAULT_RETRY_AFTER_S = 60;
const AUTH_FAILURE_THRESHOLD = 2;
const QUARANTINE_DURATION_MS = 60 * 60 * 1000; // 1 hour
const CONFIG_DEFAULT_PRIORITY = 10;
const AUTO_DETECT_PRIORITY = 100;
const RPM_SOFT_LIMIT = 0.9; // proactively skip a token above 90% of its RPM

export class TokenPool {
  private readonly tokens = new Map<string, TokenState>();

  private makeState(
    account: PoolAccountConfig,
    source: TokenState['source'],
    now: number,
  ): TokenState {
    return {
      apiKey: account.apiKey,
      label: account.label ?? `token-${account.apiKey.slice(-8)}`,
      priority: account.priority ?? CONFIG_DEFAULT_PRIORITY,
      source,
      rateLimitedUntil: 0,
      quarantinedUntil: 0,
      consecutiveAuthFailures: 0,
      requestsThisMinute: 0,
      minuteWindowStart: now,
    };
  }

  /** Register explicit config accounts (called once at startup). */
  registerConfigAccounts(
    accounts: PoolAccountConfig[],
    now: number = Date.now(),
  ): void {
    for (const account of accounts) {
      const existing = this.tokens.get(account.apiKey);
      if (existing && existing.source === 'config') {
        existing.label = account.label ?? existing.label;
        existing.priority = account.priority ?? existing.priority;
      } else {
        this.tokens.set(account.apiKey, this.makeState(account, 'config', now));
      }
    }
  }

  /** Auto-register a token seen in an incoming Authorization header. */
  autoDetect(apiKey: string, now: number = Date.now()): void {
    if (!apiKey || this.tokens.has(apiKey)) {
      return;
    }
    this.tokens.set(
      apiKey,
      this.makeState(
        {
          apiKey,
          label: `auto-${apiKey.slice(-8)}`,
          priority: AUTO_DETECT_PRIORITY,
        },
        'auto-detect',
        now,
      ),
    );
  }

  private tickWindows(now: number): void {
    for (const state of this.tokens.values()) {
      if (now - state.minuteWindowStart >= 60_000) {
        state.requestsThisMinute = 0;
        state.minuteWindowStart = now;
      }
    }
  }

  private isAvailable(state: TokenState, now: number): boolean {
    if (state.rateLimitedUntil > now || state.quarantinedUntil > now) {
      return false;
    }
    if (
      state.knownRpmLimit &&
      state.requestsThisMinute >= state.knownRpmLimit * RPM_SOFT_LIMIT
    ) {
      return false;
    }
    return true;
  }

  /** Select the best available token, or null if all are exhausted/quarantined. */
  selectToken(now: number = Date.now()): TokenState | null {
    this.tickWindows(now);
    const candidates = [...this.tokens.values()].filter((t) =>
      this.isAvailable(t, now),
    );
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) =>
      a.priority !== b.priority
        ? a.priority - b.priority
        : a.requestsThisMinute - b.requestsThisMinute,
    );
    const selected = candidates[0];
    selected.requestsThisMinute += 1;
    return selected;
  }

  /** Record a 401; after two consecutive failures the token is quarantined 1h. */
  recordAuthFailure(apiKey: string, now: number = Date.now()): void {
    const state = this.tokens.get(apiKey);
    if (!state) {
      return;
    }
    state.consecutiveAuthFailures += 1;
    if (state.consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD) {
      state.quarantinedUntil = now + QUARANTINE_DURATION_MS;
    }
  }

  /** Record a success; resets the consecutive-auth-failure counter. */
  recordSuccess(apiKey: string): void {
    const state = this.tokens.get(apiKey);
    if (state) {
      state.consecutiveAuthFailures = 0;
    }
  }

  /** Record a 429; rate-limits the token for Retry-After seconds (default 60). */
  record429(
    apiKey: string,
    retryAfterSeconds?: number,
    now: number = Date.now(),
  ): void {
    const state = this.tokens.get(apiKey);
    if (!state) {
      return;
    }
    const waitS = retryAfterSeconds ?? DEFAULT_RETRY_AFTER_S;
    state.rateLimitedUntil = now + waitS * 1000;
  }

  /** Learn the RPM limit from upstream rate-limit headers. */
  recordResponseHeaders(
    apiKey: string,
    headers: Record<string, string | string[] | undefined>,
    now: number = Date.now(),
  ): void {
    const state = this.tokens.get(apiKey);
    if (!state) {
      return;
    }
    const read = (name: string): string | undefined => {
      const v = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const limit =
      read('anthropic-ratelimit-requests-limit') ??
      read('x-ratelimit-limit-requests');
    if (limit) {
      const n = parseInt(limit, 10);
      if (!Number.isNaN(n) && n > 0) {
        state.knownRpmLimit = n;
      }
    }
    const retryAfter = read('retry-after');
    if (retryAfter && state.rateLimitedUntil <= now) {
      const waitS = parseInt(retryAfter, 10);
      if (!Number.isNaN(waitS) && waitS > 0) {
        state.rateLimitedUntil = now + waitS * 1000;
      }
    }
  }

  /** Number of registered tokens. */
  size(): number {
    return this.tokens.size;
  }

  /** Snapshot of token availability (for diagnostics). */
  getStatus(now: number = Date.now()): Array<{
    label: string;
    priority: number;
    available: boolean;
    rateLimitedUntil: number;
    quarantinedUntil: number;
  }> {
    this.tickWindows(now);
    return [...this.tokens.values()]
      .sort((a, b) => a.priority - b.priority)
      .map((t) => ({
        label: t.label,
        priority: t.priority,
        available: this.isAvailable(t, now),
        rateLimitedUntil: t.rateLimitedUntil,
        quarantinedUntil: t.quarantinedUntil,
      }));
  }
}
