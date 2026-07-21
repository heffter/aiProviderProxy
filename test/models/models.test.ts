/**
 * Model alias equivalence + capability tests (epic AIPP-4, subtask 4.2).
 */

import { describe, it, expect } from 'vitest';
import {
  buildSmartAliases,
  DEFAULT_SMART_ALIASES,
  MODEL_MAPPING,
  resolveModel,
} from '../../src/models/aliases.js';
import { ModelRegistry, modelRecord } from '../../src/models/registry.js';
import { supportsCapability } from '../../src/models/capabilities.js';

describe('legacy alias equivalence', () => {
  it('resolves every MODEL_MAPPING alias to the same provider/model as before', () => {
    for (const [alias, expected] of Object.entries(MODEL_MAPPING)) {
      expect(resolveModel(alias), alias).toEqual(expected);
    }
  });

  it('preserves the prefix rules', () => {
    expect(resolveModel('claude-opus-4-6')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    });
    expect(resolveModel('gpt-4o-2024-11-20')).toEqual({
      provider: 'openai',
      model: 'gpt-4o-2024-11-20',
    });
    expect(resolveModel('o1-preview')).toEqual({
      provider: 'openai',
      model: 'o1-preview',
    });
    expect(resolveModel('gemini-2.5-pro-preview')).toEqual({
      provider: 'google',
      model: 'gemini-2.5-pro-preview',
    });
    expect(resolveModel('grok-4-latest')).toEqual({
      provider: 'xai',
      model: 'grok-4-latest',
    });
    // deepseek-*/groq-* route to openrouter (legacy behaviour, incl. inconsistency)
    expect(resolveModel('deepseek-v3')).toEqual({
      provider: 'openrouter',
      model: 'deepseek-v3',
    });
    expect(resolveModel('openrouter/google/gemini-2.5-pro')).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-2.5-pro',
    });
    expect(resolveModel('ollama/llama3.1')).toEqual({
      provider: 'ollama',
      model: 'llama3.1',
    });
    expect(resolveModel('anthropic/claude-3-5-sonnet-latest')).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
    });
  });

  it('returns null for an unresolvable model (never a fallthrough)', () => {
    expect(resolveModel('totally-unknown-model')).toBeNull();
    expect(resolveModel('vendorx/model')).toBeNull(); // unknown slash provider
  });
});

describe('smart aliases and rp/aipp prefixes', () => {
  it('resolves default rp:* smart aliases', () => {
    expect(resolveModel('rp:balanced')).toEqual(
      DEFAULT_SMART_ALIASES['rp:balanced'],
    );
  });

  it('treats aipp:* as equivalent to rp:* without a warning', () => {
    const warnings: string[] = [];
    expect(
      resolveModel('aipp:best', { warn: (m) => warnings.push(m) }),
    ).toEqual(DEFAULT_SMART_ALIASES['rp:best']);
    expect(warnings).toEqual([]);
  });

  it('warns when the deprecated rp:/relayplane: prefixes are used', () => {
    const rp: string[] = [];
    resolveModel('rp:fast', { warn: (m) => rp.push(m) });
    expect(rp.some((w) => w.includes('deprecated'))).toBe(true);

    const legacy: string[] = [];
    resolveModel('relayplane:auto', { warn: (m) => legacy.push(m) }); // -> rp:auto -> rp:balanced
    expect(legacy.some((w) => w.includes('deprecated'))).toBe(true);
    expect(resolveModel('relayplane:auto')).toEqual(
      DEFAULT_SMART_ALIASES['rp:balanced'],
    );
  });

  it('rebuilds smart aliases from available keys', () => {
    expect(
      buildSmartAliases({ OPENROUTER_API_KEY: 'x' } as NodeJS.ProcessEnv).via,
    ).toBe('openrouter');
    expect(
      buildSmartAliases({ OPENAI_API_KEY: 'x' } as NodeJS.ProcessEnv).aliases[
        'rp:best'
      ],
    ).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(buildSmartAliases({} as NodeJS.ProcessEnv).via).toContain(
      'passthrough',
    );
  });

  it('applies config models.overrides before resolution', () => {
    expect(
      resolveModel('fast', { overrides: { fast: 'claude-3-5-haiku' } }),
    ).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });
});

describe('capability registry and filtering', () => {
  const registry = new ModelRegistry();
  registry.registerAll([
    modelRecord({
      nativeId: 'claude-sonnet-4-6',
      provider: 'anthropic',
      lifecycle: 'ga',
      capabilities: {
        streaming: 'supported',
        tools: 'supported',
        vision: 'supported',
        promptCaching: 'supported',
        reasoning: 'conditional',
      },
    }),
    modelRecord({
      nativeId: 'gpt-4o',
      provider: 'openai',
      capabilities: {
        streaming: 'supported',
        tools: 'supported',
        vision: 'supported',
        promptCaching: 'unsupported',
        reasoning: 'unsupported',
      },
    }),
    modelRecord({
      nativeId: 'o3',
      provider: 'openai',
      capabilities: {
        streaming: 'supported',
        tools: 'supported',
        vision: 'unknown',
        promptCaching: 'unsupported',
        reasoning: 'supported',
      },
    }),
  ]);

  it('looks up records and filters by capability', () => {
    expect(registry.get('gpt-4o')?.provider).toBe('openai');
    expect(
      registry.filterByCapability('promptCaching').map((r) => r.nativeId),
    ).toEqual(['claude-sonnet-4-6']);
    expect(
      registry.filterByCapability('reasoning').map((r) => r.nativeId),
    ).toEqual(['o3']);
  });

  it('honours conditional capabilities only when requested', () => {
    const caps = registry.get('claude-sonnet-4-6')!.capabilities;
    expect(supportsCapability(caps, 'reasoning')).toBe(false);
    expect(
      supportsCapability(caps, 'reasoning', { conditionalCounts: true }),
    ).toBe(true);
    expect(
      registry
        .filterByCapability('reasoning', { conditionalCounts: true })
        .map((r) => r.nativeId),
    ).toEqual(['claude-sonnet-4-6', 'o3']);
  });

  it('defaults unregistered capabilities to unknown (not supported)', () => {
    const rec = modelRecord({ nativeId: 'x', provider: 'p' });
    expect(supportsCapability(rec.capabilities, 'tools')).toBe(false);
  });
});
