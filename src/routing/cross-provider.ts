/**
 * Capability-preserving cross-provider fallback (epic AIPP-10, subtask 10.4;
 * FR-ROUTE-003/010/011). Ported from the legacy cross-provider cascade.
 *
 * When a provider fails, the router may fall back to a DIFFERENT provider -- but
 * only to a model that (a) has an explicit family mapping and (b) still satisfies
 * the original request's capability requirements. A model family with no mapping
 * is never silently sent to another provider (that could materially change
 * behaviour), so cross-provider fallback is disabled by default and, when
 * enabled, only produces candidates for which a mapping exists.
 */

import type { CapabilityName } from '../models/capabilities.js';
import type { ModelRegistry } from '../models/registry.js';
import { knownUnsupported, type RoutingCandidate } from './engine.js';

/** A provider-to-provider model family map: `[from][to][model] = mappedModel`. */
export type ModelFamilyMapping = Record<
  string,
  Record<string, Record<string, string>>
>;

/**
 * Built-in cross-provider model family mappings (ported verbatim from the legacy
 * BUILT_IN_MODEL_MAPPING). Keys are `[fromProvider][toProvider][nativeModel]`.
 */
export const BUILT_IN_MODEL_MAPPING: ModelFamilyMapping = {
  anthropic: {
    openrouter: {
      'claude-opus-4-6': 'anthropic/claude-opus-4-6',
      'claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
      'claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
      'claude-3-5-sonnet-latest': 'anthropic/claude-3-5-sonnet',
      'claude-3-5-haiku-latest': 'anthropic/claude-3-5-haiku',
      'claude-3-opus-latest': 'anthropic/claude-3-opus',
    },
    google: {
      'claude-opus-4-6': 'gemini-2.0-flash',
      'claude-sonnet-4-6': 'gemini-2.0-flash',
      'claude-haiku-4-5': 'gemini-2.0-flash-lite',
    },
  },
  openai: {
    openrouter: {
      'gpt-4o': 'openai/gpt-4o',
      'gpt-4o-mini': 'openai/gpt-4o-mini',
      'gpt-4.1': 'openai/gpt-4.1',
      o1: 'openai/o1',
      'o3-mini': 'openai/o3-mini',
    },
    anthropic: {
      'gpt-4o': 'claude-sonnet-4-6',
      'gpt-4o-mini': 'claude-haiku-4-5',
      'gpt-4.1': 'claude-sonnet-4-6',
    },
  },
  openrouter: {
    anthropic: {
      'anthropic/claude-opus-4-6': 'claude-opus-4-6',
      'anthropic/claude-sonnet-4-6': 'claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5': 'claude-haiku-4-5',
      'openai/gpt-4o': 'claude-sonnet-4-6',
    },
  },
};

/**
 * Map a model to its explicit equivalent on another provider, or null when no
 * mapping exists (custom overrides win over the built-in table). Unlike the
 * legacy manager there is NO identity fallback: an unmapped model is not
 * blindly re-sent to a different provider.
 */
export function mapModel(
  model: string,
  fromProvider: string,
  toProvider: string,
  custom?: ModelFamilyMapping,
): string | null {
  if (fromProvider === toProvider) {
    return model;
  }
  const override = custom?.[fromProvider]?.[toProvider]?.[model];
  if (override) {
    return override;
  }
  return BUILT_IN_MODEL_MAPPING[fromProvider]?.[toProvider]?.[model] ?? null;
}

/** The fallback providers to try after `current`, in configured order. */
export function fallbackProviders(
  current: string,
  providers: readonly string[],
): string[] {
  const idx = providers.indexOf(current);
  return idx === -1 ? [...providers] : providers.slice(idx + 1);
}

/**
 * Generate capability-preserving cross-provider fallback candidates for a
 * primary selection. A candidate is emitted only when an explicit family mapping
 * exists AND the mapped model is not known to lack a required capability.
 */
export function crossProviderCandidates(
  primary: RoutingCandidate,
  options: {
    providers: readonly string[];
    requiredCapabilities: CapabilityName[];
    registry: ModelRegistry;
    custom?: ModelFamilyMapping;
  },
): RoutingCandidate[] {
  const out: RoutingCandidate[] = [];
  for (const toProvider of fallbackProviders(
    primary.provider,
    options.providers,
  )) {
    const mapped = mapModel(
      primary.model,
      primary.provider,
      toProvider,
      options.custom,
    );
    if (!mapped) {
      continue; // no explicit mapping: never re-send blindly
    }
    if (
      knownUnsupported(
        options.registry.get(mapped),
        options.requiredCapabilities,
      )
    ) {
      continue; // capability mismatch: drop
    }
    out.push({ provider: toProvider, model: mapped, routedModel: mapped });
  }
  return out;
}
