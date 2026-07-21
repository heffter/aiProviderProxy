/**
 * Unit tests for the provider registry and the conformance harness
 * (epic AIPP-4, subtask 4.1).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeProviderId,
  ProviderRegistry,
  ProviderRegistryError,
} from '../../src/providers/registry.js';
import { assertAdapterConformance, makeStubAdapter } from './conformance.js';

describe('conformance harness', () => {
  it('accepts a conforming stub adapter', () => {
    assertAdapterConformance(makeStubAdapter());
  });
});

describe('ProviderRegistry', () => {
  it('registers and looks up by canonical (case-insensitive) id', () => {
    const registry = new ProviderRegistry();
    registry.register(makeStubAdapter('anthropic'));
    expect(registry.get('Anthropic').id).toBe('anthropic');
    expect(registry.has('ANTHROPIC')).toBe(true);
    expect(registry.ids()).toEqual(['anthropic']);
  });

  it('resolves registered aliases', () => {
    const registry = new ProviderRegistry();
    registry.register(makeStubAdapter('google'), {
      aliases: ['gemini', 'Google-AI'],
    });
    expect(registry.get('gemini').id).toBe('google');
    expect(registry.get('google-ai').id).toBe('google');
  });

  it('throws on a duplicate registration unless override is set', () => {
    const registry = new ProviderRegistry();
    registry.register(makeStubAdapter('openai'));
    expect(() => registry.register(makeStubAdapter('openai'))).toThrow(
      ProviderRegistryError,
    );
    expect(() =>
      registry.register(makeStubAdapter('openai'), { override: true }),
    ).not.toThrow();
  });

  it('throws on an alias that collides with an existing provider', () => {
    const registry = new ProviderRegistry();
    registry.register(makeStubAdapter('openai'));
    registry.register(makeStubAdapter('xai'));
    expect(() =>
      registry.register(makeStubAdapter('groq'), { aliases: ['openai'] }),
    ).toThrow(ProviderRegistryError);
  });

  it('treats an unknown id as a hard error, never a fallthrough', () => {
    const registry = new ProviderRegistry();
    registry.register(makeStubAdapter('openai'));
    // The legacy misroute bug: an unknown provider must NOT resolve to openai.
    expect(() => registry.get('mistral')).toThrow(ProviderRegistryError);
    expect(registry.has('mistral')).toBe(false);
  });

  it('normalizes ids (trim + lowercase)', () => {
    expect(normalizeProviderId('  OpenAI  ')).toBe('openai');
  });
});
