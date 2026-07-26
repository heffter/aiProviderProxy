/**
 * SSRF base-URL validation tests (epic AIPP-12, subtask 12.2; NFR-SEC-003/004).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateBaseUrl,
  isPrivateHost,
  BaseUrlError,
} from '../../src/config/ssrf.js';
import { loadConfig, ConfigError } from '../../src/config/loader.js';

describe('isPrivateHost', () => {
  it('flags loopback, private, and link-local hosts', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '172.16.0.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      'db.internal',
      'foo.local',
    ]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it('does not flag public hosts', () => {
    for (const h of ['api.anthropic.com', '8.8.8.8', '172.32.0.1']) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
});

describe('validateBaseUrl', () => {
  it('accepts a plain https public URL', () => {
    expect(() => validateBaseUrl('https://api.anthropic.com/v1')).not.toThrow();
  });

  it('rejects http, file, and other schemes', () => {
    expect(() => validateBaseUrl('http://api.example.com')).toThrow(
      BaseUrlError,
    );
    expect(() => validateBaseUrl('file:///etc/passwd')).toThrow(BaseUrlError);
    expect(() => validateBaseUrl('ftp://example.com')).toThrow(BaseUrlError);
  });

  it('rejects embedded credentials', () => {
    expect(() => validateBaseUrl('https://user:pass@example.com')).toThrow(
      /credentials/,
    );
  });

  it('rejects private/loopback destinations without opt-in', () => {
    expect(() => validateBaseUrl('https://169.254.169.254')).toThrow(
      /private\/loopback/,
    );
    expect(() => validateBaseUrl('https://localhost:11434')).toThrow(
      BaseUrlError,
    );
  });

  it('permits a private http URL only with opt-in', () => {
    const opt = { allowPrivateNetwork: true };
    expect(() => validateBaseUrl('http://127.0.0.1:11434', opt)).not.toThrow();
    expect(() => validateBaseUrl('https://10.0.0.5', opt)).not.toThrow();
    // http to a PUBLIC host is never allowed, even with opt-in.
    expect(() => validateBaseUrl('http://api.example.com', opt)).toThrow(
      BaseUrlError,
    );
  });
});

describe('loadConfig SSRF validation', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipp-ssrf-'));
    path = join(dir, 'config.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects a provider pointed at a private URL without opt-in', () => {
    writeFileSync(
      path,
      JSON.stringify({
        providers: { custom: { baseUrl: 'http://169.254.169.254/v1' } },
      }),
      'utf8',
    );
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(() => loadConfig(path)).toThrow(/providers\.custom\.baseUrl/);
  });

  it('allows a private base URL with the opt-in flag', () => {
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: 'http://127.0.0.1:11434',
            allowPrivateNetwork: true,
          },
        },
      }),
      'utf8',
    );
    expect(() => loadConfig(path)).not.toThrow();
  });
});
