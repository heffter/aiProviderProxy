/**
 * Routing engine tests (epic AIPP-10, subtask 10.1; FR-ROUTE-001, FR-MODEL-006).
 *
 * Mode-behaviour tests (passthrough/standard/complexity/auto/cascade) and the
 * capability-preserving candidate filter integrated with the built-in registry.
 */

import { describe, it, expect } from 'vitest';
import {
  planRoute,
  filterByCapabilities,
  knownUnsupported,
  requiredCapabilitiesFor,
  type RoutePlannerContext,
  type RoutingRequest,
} from '../../src/routing/engine.js';
import { buildModelRegistry } from '../../src/models/builtin.js';
import { ModelRegistry } from '../../src/models/registry.js';
import { defaultConfig } from '../../src/config/schema.js';

const registry = buildModelRegistry();

function ctx(routing: Record<string, unknown>): RoutePlannerContext {
  const config = defaultConfig();
  return {
    routing: {
      ...config.routing,
      ...routing,
    } as RoutePlannerContext['routing'],
    overrides: config.models.overrides,
    registry,
  };
}

function req(extra: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    requestedModel: 'claude-sonnet-4-5',
    messages: [{ role: 'user', text: 'hi' }],
    requiredCapabilities: [],
    ...extra,
  };
}

describe('planRoute mode behaviour', () => {
  it('passthrough resolves the requested model as the sole candidate', () => {
    const d = planRoute(req(), ctx({ mode: 'passthrough' }));
    expect(d).not.toBeNull();
    expect(d!.primary).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      routedModel: 'claude-sonnet-4-5',
    });
    expect(d!.fallbacks).toEqual([]);
    expect(d!.policy).toBe('passthrough');
    expect(d!.reason).toBe('passthrough');
    expect(d!.complexity).toBeUndefined();
  });

  it('standard behaves like passthrough for a single request', () => {
    const d = planRoute(req(), ctx({ mode: 'standard' }));
    expect(d!.primary.provider).toBe('anthropic');
    expect(d!.policy).toBe('standard');
    expect(d!.fallbacks).toEqual([]);
  });

  it('returns null for an unresolvable model (unknown-model signal)', () => {
    const d = planRoute(
      req({ requestedModel: 'totally-unknown-xyz' }),
      ctx({ mode: 'standard' }),
    );
    expect(d).toBeNull();
  });

  it('complexity mode selects the configured tier model and records the band', () => {
    const d = planRoute(
      req({ messages: [{ role: 'user', text: 'hello' }] }),
      ctx({
        mode: 'complexity',
        complexity: {
          enabled: true,
          simple: 'glm-5-turbo',
          moderate: 'glm-4.7',
          complex: 'glm-5.2',
        },
      }),
    );
    expect(d!.complexity).toBe('simple');
    expect(d!.primary).toEqual({
      provider: 'zai',
      model: 'glm-5-turbo',
      routedModel: 'glm-5-turbo',
    });
    expect(d!.reason).toBe('complexity:simple');
    expect(d!.policy).toBe('complexity');
  });

  it('complexity mode routes a complex prompt to the complex tier', () => {
    const d = planRoute(
      req({
        messages: [
          { role: 'user', text: 'design a distributed system architecture' },
        ],
      }),
      ctx({
        mode: 'complexity',
        complexity: {
          enabled: true,
          complex: { provider: 'zai', model: 'glm-5.2' },
        },
      }),
    );
    expect(d!.complexity).toBe('complex');
    expect(d!.primary.model).toBe('glm-5.2');
    expect(d!.reason).toBe('complexity:complex');
  });

  it('complexity mode keeps the requested model when the tier is unmapped', () => {
    const d = planRoute(
      req(),
      ctx({ mode: 'complexity', complexity: { enabled: true } }),
    );
    expect(d!.primary.model).toBe('claude-sonnet-4-5');
    expect(d!.reason).toMatch(
      /^complexity:(simple|moderate|complex):unmapped$/,
    );
  });

  it('auto mode classifies and labels its reason with the mode name', () => {
    const d = planRoute(
      req({ messages: [{ role: 'user', text: 'hello' }] }),
      ctx({
        mode: 'auto',
        complexity: { enabled: true, simple: 'glm-5-turbo' },
      }),
    );
    expect(d!.complexity).toBe('simple');
    expect(d!.primary.model).toBe('glm-5-turbo');
    expect(d!.reason).toBe('auto:simple');
  });

  it('cascade mode builds an ordered primary + fallback chain', () => {
    const d = planRoute(
      req(),
      ctx({
        mode: 'cascade',
        cascade: {
          enabled: true,
          models: ['glm-5.2', 'glm-4.7', 'claude-haiku-4-5'],
        },
      }),
    );
    expect(d!.primary.model).toBe('glm-5.2');
    expect(d!.fallbacks.map((c) => c.model)).toEqual([
      'glm-4.7',
      'claude-haiku-4-5',
    ]);
    expect(d!.reason).toBe('cascade');
  });

  it('cascade mode falls back to the requested model when unconfigured', () => {
    const d = planRoute(
      req(),
      ctx({ mode: 'cascade', cascade: { enabled: true } }),
    );
    expect(d!.primary.model).toBe('claude-sonnet-4-5');
    expect(d!.fallbacks).toEqual([]);
    expect(d!.reason).toBe('cascade:unconfigured');
  });
});

describe('capability-preserving candidate filter', () => {
  it('drops a fallback the registry KNOWS lacks reasoning', () => {
    const d = planRoute(
      req({ requiredCapabilities: ['reasoning'] }),
      ctx({
        mode: 'cascade',
        // glm-5-turbo has reasoning: unsupported and must be dropped.
        cascade: {
          enabled: true,
          models: ['glm-5.2', 'glm-5-turbo', 'glm-4.7'],
        },
      }),
    );
    expect(d!.primary.model).toBe('glm-5.2');
    expect(d!.fallbacks.map((c) => c.model)).toEqual(['glm-4.7']);
  });

  it('keeps unregistered fallbacks (unknown capabilities are not over-filtered)', () => {
    const d = planRoute(
      req({ requiredCapabilities: ['reasoning'] }),
      ctx({
        mode: 'cascade',
        cascade: { enabled: true, models: ['glm-5.2', 'claude-opus-4-5'] },
      }),
    );
    // The Claude model is not in the built-in registry -> kept despite the
    // reasoning requirement (unknown capabilities are never over-filtered).
    expect(d!.fallbacks).toHaveLength(1);
    expect(d!.fallbacks[0].provider).toBe('anthropic');
  });

  it('knownUnsupported is false for an unregistered record', () => {
    expect(knownUnsupported(undefined, ['reasoning'])).toBe(false);
    expect(knownUnsupported(registry.get('glm-5-turbo'), ['reasoning'])).toBe(
      true,
    );
    expect(knownUnsupported(registry.get('glm-5.2'), ['reasoning'])).toBe(
      false,
    );
  });

  it('filterByCapabilities is a no-op with no required capabilities', () => {
    const cands = [
      { provider: 'zai', model: 'glm-5-turbo', routedModel: 'glm-5-turbo' },
    ];
    expect(filterByCapabilities(cands, [], new ModelRegistry())).toEqual(cands);
  });
});

describe('requiredCapabilitiesFor', () => {
  it('maps feature flags to capability names', () => {
    expect(requiredCapabilitiesFor({ tools: true, reasoning: true })).toEqual([
      'tools',
      'reasoning',
    ]);
    expect(requiredCapabilitiesFor({})).toEqual([]);
    expect(requiredCapabilitiesFor({ vision: true, streaming: true })).toEqual([
      'vision',
      'streaming',
    ]);
  });
});
