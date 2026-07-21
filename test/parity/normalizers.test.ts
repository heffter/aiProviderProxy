/**
 * Unit tests for parity normalizers (epic AIPP-1, subtask 1.4).
 *
 * The load-bearing guarantee: volatile fields (ids, timestamps, latency, exact
 * content) are collapsed, but usage numbers and array ordering are NEVER
 * touched, so real protocol differences still surface.
 */

import { describe, it, expect } from 'vitest';
import {
  CONTENT_TOKEN,
  DEFAULT_NORMALIZERS,
  ID_TOKEN,
  LATENCY_TOKEN,
  normalizeHeaders,
  normalizeValue,
  TIMESTAMP_TOKEN,
} from './normalizers.js';

describe('normalizeValue collapses volatile fields', () => {
  it('collapses id / timestamp / latency keys regardless of value type', () => {
    const out = normalizeValue(
      {
        id: 'msg_abc123',
        created: 1_700_000_000,
        latency_ms: 42,
        model: 'claude-sonnet-4',
      },
      DEFAULT_NORMALIZERS,
    ) as Record<string, unknown>;
    expect(out.id).toBe(ID_TOKEN);
    expect(out.created).toBe(TIMESTAMP_TOKEN);
    expect(out.latency_ms).toBe(LATENCY_TOKEN);
    expect(out.model).toBe('claude-sonnet-4'); // structural id preserved
  });

  it('collapses id-shaped string values (msg_, chatcmpl-, UUID)', () => {
    expect(normalizeValue('chatcmpl-9abcDEF', DEFAULT_NORMALIZERS)).toBe(
      ID_TOKEN,
    );
    expect(
      normalizeValue(
        '550e8400-e29b-41d4-a716-446655440000',
        DEFAULT_NORMALIZERS,
      ),
    ).toBe(ID_TOKEN);
  });

  it('collapses scrubbed content placeholders to a single content token', () => {
    expect(normalizeValue('<scrubbed:19:9ecb1f2a>', DEFAULT_NORMALIZERS)).toBe(
      CONTENT_TOKEN,
    );
    expect(normalizeValue('<redacted:secret>', DEFAULT_NORMALIZERS)).toBe(
      CONTENT_TOKEN,
    );
  });
});

describe('normalizeValue preserves real signal', () => {
  it('never alters usage numbers', () => {
    const usage = {
      input_tokens: 1234,
      output_tokens: 56,
      cache_read_input_tokens: 7,
    };
    expect(normalizeValue({ usage }, DEFAULT_NORMALIZERS)).toEqual({ usage });
  });

  it('preserves array ordering', () => {
    const events = [
      { type: 'message_start' },
      { type: 'content_block_delta' },
      { type: 'message_stop' },
    ];
    expect(normalizeValue(events, DEFAULT_NORMALIZERS)).toEqual(events);
  });

  it('can be configured to leave content untouched', () => {
    const cfg = { ...DEFAULT_NORMALIZERS, collapseContent: false };
    expect(normalizeValue('<scrubbed:5:abcd1234>', cfg)).toBe(
      '<scrubbed:5:abcd1234>',
    );
  });
});

describe('normalizeHeaders', () => {
  it('drops volatile headers and lowercases names', () => {
    const out = normalizeHeaders({
      'Content-Type': 'application/json',
      Date: 'Mon, 01 Jan 2026 00:00:00 GMT',
      'x-request-id': 'req_1',
      'x-relay-trace-id': 'abc',
    });
    expect(out).toEqual({ 'content-type': 'application/json' });
  });
});
