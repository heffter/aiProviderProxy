/**
 * Unit tests for config schema v1 (epic AIPP-2, subtask 2.3).
 */

import { describe, it, expect } from 'vitest';
import {
  CONFIG_VERSION,
  configSchema,
  credentialRefSchema,
  defaultConfig,
} from '../../src/config/schema.js';

describe('defaultConfig', () => {
  const cfg = defaultConfig();

  it('applies the documented defaults', () => {
    expect(cfg.version).toBe(CONFIG_VERSION);
    expect(cfg.server).toMatchObject({
      port: 4100,
      host: '127.0.0.1',
      accessToken: null,
    });
    expect(cfg.protocols).toEqual({
      anthropicMessages: true,
      openaiChat: true,
      openaiResponses: { enabled: true, allowedHostedTools: [] },
    });
    expect(cfg.contentLog).toEqual({
      enabled: true,
      retentionDays: 7,
      maxEntries: 10000,
    });
    expect(cfg.routing.mode).toBe('standard');
    expect(cfg.integrations.tokemetry.enabled).toBe(false);
    expect(cfg.integrations.tokemetry.project.mode).toBe('hash');
    expect(cfg.cache.enabled).toBe(true);
  });

  it('defaults cross-provider cascade trigger statuses', () => {
    expect(cfg.routing.crossProviderCascade.triggerStatuses).toEqual([
      429, 529, 503,
    ]);
  });
});

describe('server validation', () => {
  it('rejects an out-of-range port', () => {
    expect(configSchema.safeParse({ server: { port: 70000 } }).success).toBe(
      false,
    );
    expect(configSchema.safeParse({ server: { port: 0 } }).success).toBe(false);
  });

  it('accepts a nullable access token', () => {
    const parsed = configSchema.parse({ server: { accessToken: 'secret' } });
    expect(parsed.server.accessToken).toBe('secret');
  });
});

describe('credentialRef', () => {
  it('requires name for env and path for file', () => {
    expect(
      credentialRefSchema.safeParse({ type: 'env', name: 'ANTHROPIC_API_KEY' })
        .success,
    ).toBe(true);
    expect(
      credentialRefSchema.safeParse({ type: 'file', path: '/creds.json' })
        .success,
    ).toBe(true);
    expect(credentialRefSchema.safeParse({ type: 'env' }).success).toBe(false);
    expect(
      credentialRefSchema.safeParse({ type: 'other', name: 'x' }).success,
    ).toBe(false);
  });
});

describe('providers', () => {
  it('validates openai-compatible custom entries via catchall', () => {
    const parsed = configSchema.parse({
      providers: {
        anthropic: { credential: { type: 'env', name: 'ANTHROPIC_API_KEY' } },
        'my-openai-compat': {
          baseUrl: 'https://example.com/v1',
          credential: { type: 'file', path: '/c' },
        },
      },
    });
    expect(parsed.providers['my-openai-compat']).toMatchObject({
      enabled: true,
    });
  });

  it('rejects a malformed provider credential', () => {
    expect(
      configSchema.safeParse({
        providers: { openai: { credential: { type: 'env' } } },
      }).success,
    ).toBe(false);
  });
});

describe('routing / tokemetry enums', () => {
  it('rejects an unknown routing mode', () => {
    expect(configSchema.safeParse({ routing: { mode: 'nope' } }).success).toBe(
      false,
    );
  });

  it('rejects an unknown tokemetry project mode', () => {
    expect(
      configSchema.safeParse({
        integrations: { tokemetry: { project: { mode: 'nope' } } },
      }).success,
    ).toBe(false);
  });
});

describe('version', () => {
  it('rejects a non-v1 config', () => {
    expect(configSchema.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe('unknown-key preservation', () => {
  it('preserves unknown top-level keys via passthrough', () => {
    const parsed = configSchema.parse({
      experimental: { flag: true },
    }) as Record<string, unknown>;
    expect(parsed.experimental).toEqual({ flag: true });
  });
});
