/**
 * Unit tests for OpenAI Responses request parsing/validation (AIPP-7, 7.1).
 */

import { describe, it, expect } from 'vitest';
import {
  responsesError,
  capabilityError,
  statusForResponsesError,
} from '../../../src/protocols/openai-responses/errors.js';
import {
  parseResponsesRequest,
  HOSTED_TOOL_TYPES,
} from '../../../src/protocols/openai-responses/request.js';

const valid = {
  model: 'gpt-5-codex',
  input: 'write a haiku',
};

describe('error envelope', () => {
  it('builds the OpenAI error shape and maps statuses', () => {
    expect(responsesError('rate_limit_error', 'slow down')).toEqual({
      error: {
        message: 'slow down',
        type: 'rate_limit_error',
        param: null,
        code: null,
      },
    });
    expect(
      responsesError('invalid_request_error', 'bad', {
        param: 'input',
        code: 'x',
      }),
    ).toEqual({
      error: {
        message: 'bad',
        type: 'invalid_request_error',
        param: 'input',
        code: 'x',
      },
    });
    expect(statusForResponsesError('invalid_request_error')).toBe(400);
    expect(statusForResponsesError('authentication_error')).toBe(401);
    expect(statusForResponsesError('rate_limit_error')).toBe(429);
    expect(statusForResponsesError('server_error')).toBe(500);
  });

  it('capabilityError is a coded invalid_request_error', () => {
    const env = capabilityError('nope');
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('unsupported_capability');
  });
});

describe('parseResponsesRequest — valid', () => {
  it('accepts string input as a single user message (string or object body)', () => {
    const fromObject = parseResponsesRequest(valid);
    const fromString = parseResponsesRequest(JSON.stringify(valid));
    expect(fromObject.ok).toBe(true);
    expect(fromString.ok).toBe(true);
    if (fromObject.ok) {
      expect(fromObject.request.model).toBe('gpt-5-codex');
      expect(fromObject.request.stream).toBe(false);
      expect(fromObject.request.input).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'write a haiku' }],
        },
      ]);
    }
  });

  it('accepts structured message items with content parts and role shorthand', () => {
    const res = parseResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        { role: 'system', content: 'be terse' },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.input).toHaveLength(2);
      expect(res.request.input[0]).toEqual({
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: 'be terse' }],
      });
    }
  });

  it('accepts function_call and function_call_output items', () => {
    const res = parseResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        { role: 'user', content: 'run it' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'do_thing',
          arguments: '{"a":1}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'done',
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.input[1]).toEqual({
        type: 'function_call',
        call_id: 'call_1',
        name: 'do_thing',
        arguments: '{"a":1}',
      });
      expect(res.request.input[2]).toEqual({
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'done',
      });
    }
  });

  it('stringifies non-string function_call_output content', () => {
    const res = parseResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: { ok: true },
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.request.input[0].type === 'function_call_output') {
      expect(res.request.input[0].output).toBe('{"ok":true}');
    }
  });

  it('classifies function tools and parses reasoning / limits / metadata', () => {
    const res = parseResponsesRequest({
      model: 'gpt-5-codex',
      input: 'hi',
      instructions: 'be helpful',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'weather',
          parameters: { type: 'object' },
          strict: true,
        },
      ],
      tool_choice: 'auto',
      reasoning: { effort: 'high', summary: 'auto' },
      max_output_tokens: 512,
      metadata: { session: 'abc' },
      parallel_tool_calls: false,
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.request;
      expect(r.instructions).toBe('be helpful');
      expect(r.functionTools).toEqual([
        {
          type: 'function',
          name: 'get_weather',
          description: 'weather',
          parameters: { type: 'object' },
          strict: true,
        },
      ]);
      expect(r.hostedTools).toEqual([]);
      expect(r.toolChoice).toBe('auto');
      expect(r.reasoningEffort).toBe('high');
      expect(r.reasoningSummary).toBe('auto');
      expect(r.maxOutputTokens).toBe(512);
      expect(r.metadata).toEqual({ session: 'abc' });
      expect(r.parallelToolCalls).toBe(false);
      expect(r.temperature).toBe(0.2);
      expect(r.topP).toBe(0.9);
      expect(r.stream).toBe(true);
    }
  });

  it('recognizes every hosted tool type for the routing-layer policy', () => {
    for (const type of HOSTED_TOOL_TYPES) {
      const res = parseResponsesRequest({
        model: 'gpt-5-codex',
        input: 'hi',
        tools: [{ type }],
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.request.hostedTools.map((t) => t.type)).toContain(type);
        expect(res.request.functionTools).toEqual([]);
      }
    }
  });
});

describe('parseResponsesRequest — capability rejections', () => {
  it('rejects previous_response_id with a coded capability error', () => {
    const res = parseResponsesRequest({
      ...valid,
      previous_response_id: 'resp_123',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.error.error.type).toBe('invalid_request_error');
      expect(res.error.error.code).toBe('unsupported_previous_response');
      expect(res.error.error.param).toBe('previous_response_id');
    }
  });
});

describe('parseResponsesRequest — invalid', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['invalid JSON', '{ not json', /not valid JSON/],
    ['non-object body', 42, /must be a JSON object/],
    ['missing model', { input: 'hi' }, /model: Field required/],
    ['missing input', { model: 'm' }, /input: Field required/],
    ['empty input array', { model: 'm', input: [] }, /non-empty array/],
    [
      'input item without type or role',
      { model: 'm', input: [{ content: 'x' }] },
      /type: Field required/,
    ],
    [
      'bad message role',
      { model: 'm', input: [{ role: 'tool', content: 'x' }] },
      /role: must be one of/,
    ],
    [
      'bad content part',
      { model: 'm', input: [{ role: 'user', content: [{ noType: true }] }] },
      /content part must have a string "type"/,
    ],
    [
      'function_call missing call_id',
      { model: 'm', input: [{ type: 'function_call', name: 'x' }] },
      /call_id: Field required/,
    ],
    [
      'function_call_output missing output',
      {
        model: 'm',
        input: [{ type: 'function_call_output', call_id: 'c' }],
      },
      /output: Field required/,
    ],
    [
      'unknown input item type',
      { model: 'm', input: [{ type: 'mystery' }] },
      /unsupported input item type/,
    ],
    ['non-array tools', { ...valid, tools: {} }, /tools: must be an array/],
    [
      'function tool missing name',
      { ...valid, tools: [{ type: 'function' }] },
      /name: Field required for function tools/,
    ],
    [
      'unknown tool type',
      { ...valid, tools: [{ type: 'mystery_tool' }] },
      /unsupported tool type/,
    ],
    [
      'bad reasoning effort',
      { ...valid, reasoning: { effort: 'turbo' } },
      /reasoning.effort: must be one of/,
    ],
    [
      'non-positive max_output_tokens',
      { ...valid, max_output_tokens: 0 },
      /max_output_tokens: must be a positive integer/,
    ],
    [
      'non-object metadata',
      { ...valid, metadata: [] },
      /metadata: must be an object/,
    ],
    [
      'non-boolean stream',
      { ...valid, stream: 'yes' },
      /stream: must be a boolean/,
    ],
  ];

  it.each(cases)(
    'rejects %s with a 400 invalid_request_error',
    (_label, body, pattern) => {
      const res = parseResponsesRequest(body);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(400);
        expect(res.error.error.type).toBe('invalid_request_error');
        expect(res.error.error.message).toMatch(pattern);
      }
    },
  );
});
