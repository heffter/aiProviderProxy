/**
 * Shared provider-adapter conformance harness (epic AIPP-4, subtask 4.1).
 *
 * Every adapter must pass assertAdapterConformance. makeStubAdapter builds a
 * minimal conforming adapter for registry/harness tests.
 */

import { expect } from 'vitest';
import {
  ERROR_CATEGORIES,
  type ProviderAdapter,
} from '../../src/providers/types.js';

/** Assert that `adapter` satisfies the ProviderAdapter contract. */
export function assertAdapterConformance(adapter: ProviderAdapter): void {
  expect(adapter.id, 'id must be canonical lowercase').toBe(
    adapter.id.toLowerCase(),
  );
  expect(adapter.id.length, 'id must be non-empty').toBeGreaterThan(0);
  expect(adapter.displayName.length).toBeGreaterThan(0);
  expect(adapter.upstreamProtocols.length).toBeGreaterThan(0);
  expect(adapter.authModes.length).toBeGreaterThan(0);

  expect(adapter.timeouts.connectMs).toBeGreaterThan(0);
  expect(adapter.timeouts.requestMs).toBeGreaterThan(0);
  expect(adapter.timeouts.streamIdleMs).toBeGreaterThan(0);

  expect(typeof adapter.resolveBaseUrl).toBe('function');
  expect(typeof adapter.serializeRequest).toBe('function');
  expect(typeof adapter.parseResponse).toBe('function');
  expect(typeof adapter.parseStreamEvent).toBe('function');
  expect(typeof adapter.classifyError).toBe('function');
  expect(typeof adapter.extractUsage).toBe('function');
  expect(typeof adapter.healthCheck).toBe('function');

  // resolveBaseUrl yields a valid URL and honours a config override.
  expect(() => new URL(adapter.resolveBaseUrl())).not.toThrow();
  expect(
    adapter.resolveBaseUrl({ baseUrl: 'https://override.example/v1' }),
  ).toBe('https://override.example/v1');

  // classifyError always returns a canonical category.
  expect(ERROR_CATEGORIES).toContain(adapter.classifyError({ status: 500 }));
  expect(ERROR_CATEGORIES).toContain(
    adapter.classifyError({ cause: new Error('ECONNRESET') }),
  );
}

/** Build a minimal conforming adapter (overridable id) for tests. */
export function makeStubAdapter(id = 'stub'): ProviderAdapter {
  const defaultBaseUrl = 'https://stub.example/v1';
  return {
    id,
    displayName: `Stub (${id})`,
    upstreamProtocols: ['openai_chat'],
    authModes: ['env'],
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      promptCaching: false,
      reasoning: false,
    },
    timeouts: { connectMs: 5000, requestMs: 60000, streamIdleMs: 30000 },
    retrySafety: { preStream: true, postStream: false },
    resolveBaseUrl: (config) => config?.baseUrl ?? defaultBaseUrl,
    serializeRequest: (request, config) => ({
      url: `${config?.baseUrl ?? defaultBaseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(request.headers ?? {}),
      },
      body: JSON.stringify(request.body),
    }),
    parseResponse: (response) => ({
      status: response.status,
      body: response.body,
    }),
    parseStreamEvent: (raw) => (raw ? [{ event: 'data', data: raw }] : []),
    classifyError: ({ status, cause }) => {
      if (cause) {
        return 'provider_connection_error';
      }
      if (status === 429) {
        return 'provider_rate_limited';
      }
      return 'internal_error';
    },
    extractUsage: () => undefined,
    healthCheck: async () => true,
  };
}
