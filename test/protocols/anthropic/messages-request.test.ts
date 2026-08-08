/**
 * Unit tests for Anthropic Messages request parsing/validation (AIPP-6, 6.1).
 */

import { describe, it, expect } from 'vitest';
import {
  anthropicError,
  statusForAnthropicError,
} from '../../../src/protocols/anthropic/errors.js';
import { parseMessagesRequest } from '../../../src/protocols/anthropic/messages-request.js';

const valid = {
  model: 'claude-sonnet-4',
  max_tokens: 1024,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

describe('error envelope', () => {
  it('builds the Anthropic error shape and maps statuses', () => {
    expect(anthropicError('rate_limit_error', 'slow down')).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
    expect(statusForAnthropicError('invalid_request_error')).toBe(400);
    expect(statusForAnthropicError('authentication_error')).toBe(401);
    expect(statusForAnthropicError('overloaded_error')).toBe(529);
  });
});

describe('parseMessagesRequest — valid', () => {
  it('accepts a well-formed request (string or object body)', () => {
    const fromObject = parseMessagesRequest(valid);
    const fromString = parseMessagesRequest(JSON.stringify(valid));
    expect(fromObject.ok).toBe(true);
    expect(fromString.ok).toBe(true);
    if (fromObject.ok) {
      expect(fromObject.request).toMatchObject({
        model: 'claude-sonnet-4',
        max_tokens: 1024,
        stream: false,
      });
    }
  });

  it('accepts string content and a tools array', () => {
    const res = parseMessagesRequest({
      ...valid,
      messages: [{ role: 'user', content: 'plain' }],
      tools: [{ name: 't' }],
      stream: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.stream).toBe(true);
    }
  });

  it('accepts a mid-conversation system message', () => {
    // Regression: rejecting this 400'd real Claude Code traffic with
    // `messages.1.role: must be "user" or "assistant"`. A system message inside
    // the messages array is an operator instruction that avoids invalidating
    // the cached prefix; the upstream accepts it on models that support it, so
    // the gateway must not be stricter than the API it proxies.
    const res = parseMessagesRequest({
      ...valid,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'The user prefers Go.' },
      ],
    });
    expect(res.ok).toBe(true);
  });

  it('accepts a system message with block content', () => {
    const res = parseMessagesRequest({
      ...valid,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [{ type: 'text', text: 'Be terse.' }] },
      ],
    });
    expect(res.ok).toBe(true);
  });

  it('leaves system-message placement rules to the upstream', () => {
    // The API requires a system message to follow a user turn and never be
    // first. The gateway deliberately does not re-validate that: duplicating
    // upstream placement rules is how it started rejecting valid requests.
    const res = parseMessagesRequest({
      ...valid,
      messages: [{ role: 'system', content: 'first' }],
    });
    expect(res.ok).toBe(true);
  });
});

describe('parseMessagesRequest — invalid', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['invalid JSON', '{ not json', /not valid JSON/],
    ['non-object body', 42, /must be a JSON object/],
    ['missing model', { ...valid, model: undefined }, /model: Field required/],
    [
      'missing messages',
      { ...valid, messages: [] },
      /messages: Field required/,
    ],
    // NOTE: `system` used to live here as a "bad role". It is not one -- a
    // mid-conversation system message is a valid Messages request, and
    // rejecting it broke real Claude Code traffic. See the accepted-role test
    // below. A genuinely unknown role is still rejected.
    [
      'unknown role',
      { ...valid, messages: [{ role: 'developer', content: 'x' }] },
      /role: must be/,
    ],
    [
      'bad content block',
      { ...valid, messages: [{ role: 'user', content: [{ noType: true }] }] },
      /must have a string "type"/,
    ],
    [
      'missing max_tokens',
      { ...valid, max_tokens: 0 },
      /max_tokens: Field required/,
    ],
    [
      'non-boolean stream',
      { ...valid, stream: 'yes' },
      /stream: must be a boolean/,
    ],
    ['non-array tools', { ...valid, tools: {} }, /tools: must be an array/],
  ];

  it.each(cases)(
    'rejects %s with a 400 invalid_request_error',
    (_label, body, pattern) => {
      const res = parseMessagesRequest(body);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(400);
        expect(res.error.error.type).toBe('invalid_request_error');
        expect(res.error.error.message).toMatch(pattern);
      }
    },
  );
});
