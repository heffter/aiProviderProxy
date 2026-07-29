/**
 * Unit tests for the local content buffer (Task 16).
 *
 * Proves the read-and-clear contract, oldest-first eviction, and that stored
 * request/response values are redacted and bounded by the gateway's size and
 * JSON-depth limits before they can reach the history log.
 */

import { describe, it, expect } from 'vitest';
import { ContentBuffer } from '../../src/gateway/content-buffer.js';

describe('ContentBuffer', () => {
  it('records and drains content keyed by logicalRequestId', () => {
    const buffer = new ContentBuffer();
    buffer.record('lr-1', { prompt: 'hello' }, { reply: 'hi' });
    expect(buffer.take('lr-1')).toEqual({
      request: { prompt: 'hello' },
      response: { reply: 'hi' },
    });
  });

  it('take is read-and-clear: a second take returns undefined', () => {
    const buffer = new ContentBuffer();
    buffer.record('lr-1', { a: 1 }, { b: 2 });
    expect(buffer.take('lr-1')).toBeDefined();
    expect(buffer.take('lr-1')).toBeUndefined();
    expect(buffer.size).toBe(0);
  });

  it('returns undefined for an unknown id (failed request / cache hit)', () => {
    const buffer = new ContentBuffer();
    expect(buffer.take('missing')).toBeUndefined();
  });

  it('redacts credential shapes and sensitive keys before storing', () => {
    const buffer = new ContentBuffer();
    buffer.record(
      'lr-1',
      { token: 'sk-ant-api03-abcdefgh12345678', apiKey: 'secret-value' },
      { text: 'contact Bearer abcdefgh12345678 for access' },
    );
    const content = buffer.take('lr-1');
    const serialized = JSON.stringify(content);
    // Pattern-matched credential is scrubbed from the string...
    expect(serialized).not.toContain('sk-ant-api03-abcdefgh12345678');
    expect(serialized).not.toContain('abcdefgh12345678');
    // ...and a value under a sensitive key is dropped wholesale.
    expect(serialized).not.toContain('secret-value');
    expect(serialized).toContain('<redacted');
  });

  it('replaces an oversized value with an omission marker', () => {
    const buffer = new ContentBuffer({ limits: { maxBytes: 50 } });
    const big = { blob: 'x'.repeat(200) };
    buffer.record('lr-1', big, { ok: true });
    const content = buffer.take('lr-1');
    expect(content?.request).toEqual({
      omitted: expect.stringContaining('50'),
    });
    // A within-limit value on the same entry is preserved.
    expect(content?.response).toEqual({ ok: true });
  });

  it('replaces a too-deeply-nested value with an omission marker', () => {
    const buffer = new ContentBuffer({ limits: { maxDepth: 3 } });
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };
    buffer.record('lr-1', deep, { ok: true });
    const content = buffer.take('lr-1');
    expect(content?.request).toEqual({
      omitted: expect.stringContaining('nesting'),
    });
    expect(content?.response).toEqual({ ok: true });
  });

  it('caps entries and evicts oldest-first when a drain never arrives', () => {
    const buffer = new ContentBuffer({ maxEntries: 2 });
    buffer.record('lr-1', { n: 1 }, {});
    buffer.record('lr-2', { n: 2 }, {});
    buffer.record('lr-3', { n: 3 }, {});
    expect(buffer.size).toBe(2);
    // The oldest (lr-1) was evicted; the two newest survive.
    expect(buffer.take('lr-1')).toBeUndefined();
    expect(buffer.take('lr-2')).toBeDefined();
    expect(buffer.take('lr-3')).toBeDefined();
  });

  it('re-recording an id overwrites without counting against the cap', () => {
    const buffer = new ContentBuffer({ maxEntries: 2 });
    buffer.record('lr-1', { v: 'first' }, {});
    buffer.record('lr-2', { v: 'x' }, {});
    buffer.record('lr-1', { v: 'second' }, {});
    expect(buffer.size).toBe(2);
    expect(buffer.take('lr-1')).toEqual({
      request: { v: 'second' },
      response: {},
    });
  });
});
