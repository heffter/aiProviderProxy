/**
 * Provider registry (epic AIPP-4, subtask 4.1; FR-PROV-001..015).
 *
 * Registers provider adapters under canonical lowercase ids with alias
 * normalization and conflict detection. Lookup of an unknown id is a hard
 * validation error -- it NEVER falls through to another provider. This kills the
 * legacy misroute bug where unmapped providers were silently sent to
 * api.openai.com with the wrong key.
 */

import type { ProviderAdapter } from './types.js';

/** Thrown on registration conflicts or unknown-provider lookups. */
export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRegistryError';
  }
}

/** Options when registering an adapter. */
export interface RegisterOptions {
  aliases?: string[];
  /** Allow replacing an already-registered id/alias. */
  override?: boolean;
}

/** Normalize a provider id or alias to its canonical form. */
export function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase();
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly aliases = new Map<string, string>();

  /** Register an adapter and optional aliases. Throws on a conflict. */
  register(adapter: ProviderAdapter, options: RegisterOptions = {}): void {
    const id = normalizeProviderId(adapter.id);
    if (id.length === 0) {
      throw new ProviderRegistryError('Provider id must be non-empty.');
    }
    if (!options.override && this.adapters.has(id)) {
      throw new ProviderRegistryError(
        `Provider "${id}" is already registered.`,
      );
    }
    if (this.aliases.has(id) && this.aliases.get(id) !== id) {
      throw new ProviderRegistryError(
        `Provider id "${id}" conflicts with an existing alias.`,
      );
    }
    this.adapters.set(id, adapter);

    for (const rawAlias of options.aliases ?? []) {
      const alias = normalizeProviderId(rawAlias);
      if (alias === id) {
        continue;
      }
      const existing = this.aliases.get(alias);
      if (
        (this.adapters.has(alias) || (existing && existing !== id)) &&
        !options.override
      ) {
        throw new ProviderRegistryError(
          `Alias "${alias}" conflicts with an existing provider or alias.`,
        );
      }
      this.aliases.set(alias, id);
    }
  }

  /** True if `idOrAlias` resolves to a registered adapter. */
  has(idOrAlias: string): boolean {
    const key = normalizeProviderId(idOrAlias);
    return this.adapters.has(key) || this.aliases.has(key);
  }

  /**
   * Look up an adapter by id or alias.
   * @throws {ProviderRegistryError} if unknown -- never falls through.
   */
  get(idOrAlias: string): ProviderAdapter {
    const key = normalizeProviderId(idOrAlias);
    const canonical = this.adapters.has(key) ? key : this.aliases.get(key);
    if (!canonical) {
      throw new ProviderRegistryError(
        `Unknown provider "${idOrAlias}". Register an adapter; requests are never routed to a fallback provider.`,
      );
    }
    const adapter = this.adapters.get(canonical);
    if (!adapter) {
      throw new ProviderRegistryError(
        `Alias "${idOrAlias}" points at unregistered provider "${canonical}".`,
      );
    }
    return adapter;
  }

  /** All registered adapters (canonical, de-duplicated). */
  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  /** Canonical ids of registered adapters. */
  ids(): string[] {
    return [...this.adapters.keys()];
  }
}
