/**
 * Unit tests for GLM model registry entries and resolution (AIPP-9, 9.2).
 */

import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../src/models/aliases.js';
import { GLM_MODELS, buildModelRegistry } from '../../src/models/builtin.js';

describe('GLM alias resolution', () => {
  it('resolves named GLM aliases to the zai provider', () => {
    expect(resolveModel('glm-5.2')).toEqual({
      provider: 'zai',
      model: 'glm-5.2',
    });
    expect(resolveModel('glm-5-turbo')).toEqual({
      provider: 'zai',
      model: 'glm-5-turbo',
    });
    expect(resolveModel('glm-4.7')).toEqual({
      provider: 'zai',
      model: 'glm-4.7',
    });
  });

  it('resolves the bare "glm" alias to the default GLM model', () => {
    expect(resolveModel('glm')).toEqual({ provider: 'zai', model: 'glm-5.2' });
  });

  it('resolves any glm- prefixed model to zai (prefix rule)', () => {
    expect(resolveModel('glm-6-experimental')).toEqual({
      provider: 'zai',
      model: 'glm-6-experimental',
    });
  });

  it('resolves the zai/ slash prefix', () => {
    expect(resolveModel('zai/glm-5.2')).toEqual({
      provider: 'zai',
      model: 'glm-5.2',
    });
  });
});

describe('GLM model records and capability filtering', () => {
  const registry = buildModelRegistry();

  it('registers the GLM family under the zai provider', () => {
    expect(GLM_MODELS.map((m) => m.nativeId)).toEqual([
      'glm-5.2',
      'glm-5-turbo',
      'glm-4.7',
    ]);
    expect(registry.get('glm-5.2')?.provider).toBe('zai');
    expect(registry.get('glm-5.2')?.contextLimit).toBe(200_000);
  });

  it('routing selects reasoning-capable GLM models only', () => {
    const reasoning = registry
      .filterByCapability('reasoning', { provider: 'zai' })
      .map((m) => m.nativeId);
    // glm-5-turbo trades reasoning for latency and is excluded.
    expect(reasoning).toEqual(['glm-5.2', 'glm-4.7']);
  });

  it('every GLM model supports streaming, tools, and prompt caching', () => {
    for (const cap of ['streaming', 'tools', 'promptCaching'] as const) {
      expect(registry.filterByCapability(cap, { provider: 'zai' }).length).toBe(
        GLM_MODELS.length,
      );
    }
  });
});
