/**
 * Unit tests for the central redaction utility (epic AIPP-2, subtask 2.4).
 */

import { describe, it, expect } from 'vitest';
import {
  REDACTED,
  REDACTED_SECRET,
  isSensitiveKey,
  redactError,
  redactString,
  redactValue,
  safeStringify,
  serializeForDiagnostics,
} from '../../src/config/redact.js';

const SECRETS = {
  anthropic: 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1111',
  openai: 'sk-1234567890abcdefghijABCDEF',
  bearer: 'Bearer abcDEF123.ghiJKL456-mnoPQR789',
  google: 'AIzaSyA1234567890abcdefghijklmnopqrstuvw',
};

describe('redactString', () => {
  it('redacts every credential family in free text', () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const out = redactString(`prefix ${secret} suffix`);
      expect(out, name).not.toContain(secret);
      expect(out, name).toContain(REDACTED_SECRET);
    }
  });

  it('leaves ordinary text untouched', () => {
    expect(redactString('routing mode is standard')).toBe(
      'routing mode is standard',
    );
  });
});

describe('isSensitiveKey', () => {
  it('matches secret-bearing key names', () => {
    for (const key of [
      'accessToken',
      'apiKey',
      'api_key',
      'authorization',
      'x-api-key',
      'cookie',
      'credential',
      'password',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('does not match ordinary keys', () => {
    for (const key of ['port', 'host', 'mode', 'enabled', 'model']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('redactValue', () => {
  it('drops values under sensitive keys but keeps null (not set)', () => {
    const out = redactValue({
      server: { port: 4100, accessToken: 'supersecret' },
      empty: { accessToken: null },
    }) as {
      server: { port: number; accessToken: string };
      empty: { accessToken: null };
    };
    expect(out.server.port).toBe(4100);
    expect(out.server.accessToken).toBe(REDACTED);
    expect(out.empty.accessToken).toBeNull();
  });

  it('redacts a config credential reference field', () => {
    const out = redactValue({
      providers: {
        anthropic: { credential: { type: 'env', name: 'ANTHROPIC_API_KEY' } },
      },
    }) as { providers: { anthropic: { credential: unknown } } };
    expect(out.providers.anthropic.credential).toBe(REDACTED);
  });

  it('redacts secret-shaped strings even under ordinary keys', () => {
    const out = redactValue({ note: `use ${SECRETS.anthropic}` }) as {
      note: string;
    };
    expect(out.note).not.toContain('sk-ant-');
    expect(out.note).toContain(REDACTED_SECRET);
  });

  it('preserves numbers, booleans, and array ordering', () => {
    const input = { list: [1, 2, 3], flag: true, n: 42 };
    expect(redactValue(input)).toEqual(input);
  });
});

describe('safeStringify / redactError', () => {
  it('produces secret-free JSON', () => {
    const json = safeStringify({ authorization: SECRETS.bearer, port: 4100 });
    expect(json).not.toContain('Bearer');
    expect(json).toContain('4100');
  });

  it('redacts secrets in error messages', () => {
    expect(
      redactError(new Error(`upstream rejected ${SECRETS.openai}`)),
    ).not.toContain(SECRETS.openai);
  });
});

describe('serializeForDiagnostics', () => {
  it('keeps only allowlisted keys, redacted', () => {
    const out = serializeForDiagnostics(
      { host: '127.0.0.1', accessToken: 'secret', internal: 'drop-me' },
      ['host', 'accessToken'],
    );
    expect(out).toEqual({ host: '127.0.0.1', accessToken: REDACTED });
    expect(out).not.toHaveProperty('internal');
  });
});

describe('idempotency (redact(redact(x)) is stable)', () => {
  const samples: unknown[] = [
    { server: { accessToken: 'secret', port: 4100 } },
    { note: `key ${SECRETS.anthropic} and ${SECRETS.bearer}` },
    { providers: { openai: { credential: { type: 'file', path: '/c' } } } },
    [{ apiKey: 'x' }, { authorization: SECRETS.google }],
  ];

  it('is stable under a second pass', () => {
    for (const sample of samples) {
      const once = redactValue(sample);
      const twice = redactValue(once);
      expect(twice).toEqual(once);
    }
  });
});
