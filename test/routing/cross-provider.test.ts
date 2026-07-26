/**
 * Cross-provider mapping unit tests (epic AIPP-10, subtask 10.4;
 * FR-ROUTE-003/010).
 */

import { describe, it, expect } from 'vitest';
import {
  mapModel,
  fallbackProviders,
  crossProviderCandidates,
  type ModelFamilyMapping,
} from '../../src/routing/cross-provider.js';
import { buildModelRegistry } from '../../src/models/builtin.js';
import { ModelRegistry, modelRecord } from '../../src/models/registry.js';

describe('mapModel', () => {
  it('returns the model unchanged within the same provider', () => {
    expect(mapModel('claude-opus-4-6', 'anthropic', 'anthropic')).toBe(
      'claude-opus-4-6',
    );
  });

  it('uses the built-in family mapping across providers', () => {
    expect(mapModel('claude-sonnet-4-6', 'anthropic', 'google')).toBe(
      'gemini-2.0-flash',
    );
  });

  it('returns null when no explicit mapping exists (no blind re-send)', () => {
    expect(mapModel('some-unmapped-model', 'anthropic', 'google')).toBeNull();
  });

  it('lets a custom mapping override the built-in table', () => {
    const custom: ModelFamilyMapping = {
      anthropic: { google: { 'claude-sonnet-4-6': 'gemini-1.5-pro' } },
    };
    expect(mapModel('claude-sonnet-4-6', 'anthropic', 'google', custom)).toBe(
      'gemini-1.5-pro',
    );
  });
});

describe('fallbackProviders', () => {
  it('returns providers after the current one, in order', () => {
    expect(
      fallbackProviders('anthropic', ['anthropic', 'openrouter', 'google']),
    ).toEqual(['openrouter', 'google']);
  });

  it('returns all when the current provider is not listed', () => {
    expect(fallbackProviders('xai', ['anthropic', 'google'])).toEqual([
      'anthropic',
      'google',
    ]);
  });
});

describe('crossProviderCandidates', () => {
  const primary = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    routedModel: 'claude-sonnet-4-6',
  };

  it('emits mapped candidates for providers with an explicit mapping', () => {
    const candidates = crossProviderCandidates(primary, {
      providers: ['anthropic', 'google', 'openrouter'],
      requiredCapabilities: [],
      registry: buildModelRegistry(),
    });
    expect(candidates).toEqual([
      {
        provider: 'google',
        model: 'gemini-2.0-flash',
        routedModel: 'gemini-2.0-flash',
      },
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-6',
        routedModel: 'anthropic/claude-sonnet-4-6',
      },
    ]);
  });

  it('skips a provider that has no explicit mapping for the model', () => {
    const candidates = crossProviderCandidates(
      {
        provider: 'anthropic',
        model: 'claude-unmapped',
        routedModel: 'claude-unmapped',
      },
      {
        providers: ['anthropic', 'google'],
        requiredCapabilities: [],
        registry: buildModelRegistry(),
      },
    );
    expect(candidates).toEqual([]);
  });

  it('drops a mapped candidate that is known to lack a required capability', () => {
    // A registry where the mapped target lacks vision -> capability mismatch.
    const registry = new ModelRegistry();
    registry.register(
      modelRecord({
        nativeId: 'gemini-2.0-flash',
        provider: 'google',
        capabilities: {
          streaming: 'supported',
          tools: 'supported',
          vision: 'unsupported',
          promptCaching: 'unknown',
          reasoning: 'unknown',
        },
      }),
    );
    const candidates = crossProviderCandidates(primary, {
      providers: ['anthropic', 'google'],
      requiredCapabilities: ['vision'],
      registry,
    });
    expect(candidates).toEqual([]); // gemini-2.0-flash dropped (no vision)
  });
});
