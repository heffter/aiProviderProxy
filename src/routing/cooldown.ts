/**
 * Provider cooldown / circuit breaking (epic AIPP-10, subtask 10.4;
 * FR-ROUTE-011). Ported from the legacy CooldownManager.
 *
 * Tracks recent failures per provider within a sliding window; once a provider
 * trips the failure threshold it is cooled down for a fixed interval and skipped
 * as a routing candidate. The breaker self-heals: the first availability check
 * after the cooldown elapses clears the state. The clock is injectable so the
 * whole thing is deterministic under test.
 */

/** Cooldown configuration. */
export interface CooldownConfig {
  enabled: boolean;
  /** Failures within the window that trip a cooldown. */
  allowedFails: number;
  /** Sliding failure-count window, in seconds. */
  windowSeconds: number;
  /** How long a tripped provider stays cooled, in seconds. */
  cooldownSeconds: number;
}

/** The default cooldown policy (ported from the legacy defaults). */
export const DEFAULT_COOLDOWN_CONFIG: CooldownConfig = {
  enabled: true,
  allowedFails: 3,
  windowSeconds: 60,
  cooldownSeconds: 120,
};

interface ProviderHealth {
  failures: number[];
  cooledUntil: number | null;
}

/**
 * Per-provider cooldown circuit breaker. `recordFailure`/`recordSuccess` feed
 * it; `isAvailable` is consulted by the router before dispatching to a provider.
 */
export class CooldownManager {
  private readonly health = new Map<string, ProviderHealth>();
  private config: CooldownConfig;
  private readonly now: () => number;

  constructor(
    config: CooldownConfig = DEFAULT_COOLDOWN_CONFIG,
    deps: { now?: () => number } = {},
  ) {
    this.config = config;
    this.now = deps.now ?? Date.now;
  }

  /** Replace the active configuration (e.g. on a config reload). */
  updateConfig(config: CooldownConfig): void {
    this.config = config;
  }

  /** Record a provider failure; trips a cooldown at the threshold. */
  recordFailure(provider: string): void {
    if (!this.config.enabled) {
      return;
    }
    const h = this.getOrCreate(provider);
    const now = this.now();
    h.failures = h.failures.filter(
      (t) => now - t < this.config.windowSeconds * 1000,
    );
    h.failures.push(now);
    if (h.failures.length >= this.config.allowedFails) {
      h.cooledUntil = now + this.config.cooldownSeconds * 1000;
    }
  }

  /** Record a provider success; clears any accumulated failures/cooldown. */
  recordSuccess(provider: string): void {
    const h = this.health.get(provider);
    if (h) {
      h.failures = [];
      h.cooledUntil = null;
    }
  }

  /** True when a provider may be dispatched to (self-heals once cooled off). */
  isAvailable(provider: string): boolean {
    if (!this.config.enabled) {
      return true;
    }
    const h = this.health.get(provider);
    if (!h?.cooledUntil) {
      return true;
    }
    if (this.now() > h.cooledUntil) {
      h.cooledUntil = null;
      h.failures = [];
      return true;
    }
    return false;
  }

  private getOrCreate(provider: string): ProviderHealth {
    let h = this.health.get(provider);
    if (!h) {
      h = { failures: [], cooledUntil: null };
      this.health.set(provider, h);
    }
    return h;
  }
}
