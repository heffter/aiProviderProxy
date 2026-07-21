/**
 * Unit tests for the fixture scrubber (epic AIPP-1, subtask 1.2).
 *
 * Core guarantee under test: no raw prompt/response content and no secret
 * pattern survives scrubbing, while structure (block types, roles, model ids,
 * tool schemas, event ordering, usage numbers) is preserved.
 */

import { describe, it, expect } from 'vitest';
import {
  containsSecret,
  redactSecrets,
  scrubHeaders,
  scrubJson,
  scrubText,
  scrubValue,
  SECRET_PLACEHOLDER,
} from './scrubber.js';

// Distinctive tokens so assertions can prove the literal content is gone.
const PROMPT = 'CONTENTTOKEN_kubernetes_rollout_question';
const COMPLETION = 'CONTENTTOKEN_helpful_assistant_answer';
const SECRETS = {
  anthropic: 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1111',
  anthropicOat: 'sk-ant-oat01-ZZZZYYYYXXXXWWWWVVVV',
  openai: 'sk-1234567890abcdefghijABCDEF',
  openaiProj: 'sk-proj-abcdEFGH1234ijklMNOP5678qrst',
  openrouter: 'sk-or-v1-0123456789abcdef0123456789abcdef',
  bearer: 'Bearer abcDEF123.ghiJKL456-mnoPQR789',
  google: 'AIzaSyA1234567890abcdefghijklmnopqrstuvw',
  xai: 'xai-abcdefghij1234567890ABCDEFGHIJ',
  groq: 'gsk_abcdefghijklmnopqrstuvwxyz0123456789',
};

describe('redactSecrets / containsSecret', () => {
  it('redacts every supported credential family', () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const redacted = redactSecrets(`prefix ${secret} suffix`);
      expect(redacted, name).not.toContain(secret);
      expect(redacted, name).toContain(SECRET_PLACEHOLDER);
      expect(containsSecret(secret), name).toBe(true);
    }
  });

  it('leaves structural identifiers untouched', () => {
    for (const clean of [
      'claude-sonnet-4-20250514',
      'gpt-4o',
      'tool_use',
      'assistant',
    ]) {
      expect(redactSecrets(clean)).toBe(clean);
      expect(containsSecret(clean)).toBe(false);
    }
  });

  it('is stateless across repeated containsSecret calls (global regex lastIndex)', () => {
    expect(containsSecret(SECRETS.openai)).toBe(true);
    expect(containsSecret(SECRETS.openai)).toBe(true);
  });
});

describe('scrubText', () => {
  it('replaces content with a deterministic, non-reversible placeholder', () => {
    const a = scrubText(PROMPT);
    const b = scrubText(PROMPT);
    expect(a).toBe(b); // deterministic
    expect(a).not.toContain('kubernetes');
    expect(a).toMatch(/^<scrubbed:\d+:[0-9a-f]{8}>$/);
  });

  it('does not feed secret material into the placeholder hash', () => {
    const scrubbed = scrubText(`please use ${SECRETS.anthropic}`);
    expect(scrubbed).not.toContain('sk-ant-');
  });

  it('keeps empty strings empty', () => {
    expect(scrubText('')).toBe('');
  });
});

describe('scrubHeaders', () => {
  it('keeps only allowlisted headers and drops auth headers entirely', () => {
    const scrubbed = scrubHeaders({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      Authorization: SECRETS.bearer,
      'x-api-key': SECRETS.anthropic,
      Cookie: 'session=abc',
      'x-stainless-lang': 'js',
    });
    expect(scrubbed).toEqual({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.stringify(scrubbed)).not.toContain('sk-ant-');
    expect(JSON.stringify(scrubbed)).not.toContain('Bearer');
  });

  it('redacts secrets that appear inside an allowlisted header value', () => {
    const scrubbed = scrubHeaders({ 'user-agent': `sdk ${SECRETS.openai}` });
    expect(scrubbed['user-agent']).toContain(SECRET_PLACEHOLDER);
    expect(scrubbed['user-agent']).not.toContain(SECRETS.openai);
  });

  it('returns an empty object for missing headers', () => {
    expect(scrubHeaders(undefined)).toEqual({});
  });
});

describe('scrubValue structure preservation', () => {
  it('preserves numbers, enums, ordering and object keys', () => {
    const usage = {
      input_tokens: 1234,
      output_tokens: 56,
      cache_read_input_tokens: 7,
    };
    expect(scrubJson(usage)).toEqual(usage); // all numbers preserved verbatim

    const block = { type: 'text', text: PROMPT };
    const scrubbed = scrubValue(block) as { type: string; text: string };
    expect(scrubbed.type).toBe('text'); // enum preserved
    expect(scrubbed.text).not.toContain('kubernetes'); // content scrubbed
  });

  it('preserves array ordering while scrubbing element content', () => {
    const events = [
      { type: 'a', text: 'one' },
      { type: 'b', text: 'two' },
      { type: 'c', text: 'three' },
    ];
    const scrubbed = scrubValue(events) as Array<{
      type: string;
      text: string;
    }>;
    expect(scrubbed.map((e) => e.type)).toEqual(['a', 'b', 'c']);
    expect(scrubbed[1].text).not.toContain('two');
  });

  it('preserves tool schemas (names, property names, required, types)', () => {
    const tools = [
      {
        name: 'get_weather',
        description: 'Look up the weather',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string' },
            units: { type: 'string' },
          },
          required: ['location'],
        },
      },
    ];
    const scrubbed = scrubValue(tools, 'tools') as typeof tools;
    expect(scrubbed[0].name).toBe('get_weather');
    expect(scrubbed[0].input_schema).toEqual(tools[0].input_schema); // schema intact
  });
});

describe('scrubValue whole-payload guarantee', () => {
  const request = {
    model: 'claude-sonnet-4-20250514',
    system: `You are ${COMPLETION}`,
    messages: [
      { role: 'user', content: [{ type: 'text', text: PROMPT }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'search', input: { query: PROMPT } },
        ],
      },
    ],
    tools: [
      {
        name: 'search',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ],
    metadata: { note: `contact ${SECRETS.bearer}` },
    usage: { input_tokens: 42, output_tokens: 8 },
  };

  it('drops all raw content and secrets but keeps structure', () => {
    const serialized = JSON.stringify(scrubJson(request));

    // No raw content survives.
    expect(serialized).not.toContain(PROMPT);
    expect(serialized).not.toContain(COMPLETION);
    expect(serialized).not.toContain('kubernetes');

    // No secret pattern survives.
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('sk-ant-');
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(containsSecret(serialized)).toBe(false);

    // Structure survives.
    expect(serialized).toContain('"type":"text"');
    expect(serialized).toContain('"role":"user"');
    expect(serialized).toContain('"model":"claude-sonnet-4-20250514"');
    expect(serialized).toContain('"name":"search"'); // tool schema name
    expect(serialized).toContain('"input_tokens":42'); // usage number
  });
});
