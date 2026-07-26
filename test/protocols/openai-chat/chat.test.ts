/**
 * Unit tests for the OpenAI Chat Completions surface (AIPP-8, 8.1):
 * request validation, chat.completion construction, and the chunk encoder.
 */

import { describe, it, expect } from 'vitest';
import {
  chatError,
  statusForChatError,
} from '../../../src/protocols/openai-chat/errors.js';
import { parseChatRequest } from '../../../src/protocols/openai-chat/request.js';
import {
  buildChatCompletion,
  renderChatUsage,
  type CanonicalChatResult,
} from '../../../src/protocols/openai-chat/response.js';
import {
  ChatChunkEncoder,
  encodeChatStream,
  type ChatStreamEvent,
} from '../../../src/protocols/openai-chat/stream-encoder.js';

function seqIdGen(): () => string {
  let n = 0;
  return () => `id${(n += 1)}`;
}
const fixedNow = (): number => 1_700_000_000_000;

const valid = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('error envelope', () => {
  it('builds the OpenAI shape and maps statuses', () => {
    expect(chatError('rate_limit_error', 'slow')).toEqual({
      error: {
        message: 'slow',
        type: 'rate_limit_error',
        param: null,
        code: null,
      },
    });
    expect(statusForChatError('invalid_request_error')).toBe(400);
    expect(statusForChatError('authentication_error')).toBe(401);
    expect(statusForChatError('server_error')).toBe(500);
  });
});

describe('parseChatRequest — valid', () => {
  it('accepts a well-formed request (string or object body)', () => {
    expect(parseChatRequest(valid).ok).toBe(true);
    const res = parseChatRequest(JSON.stringify(valid));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.model).toBe('gpt-4o');
      expect(res.request.stream).toBe(false);
    }
  });

  it('accepts an assistant tool_calls message with null content', () => {
    const res = parseChatRequest({
      ...valid,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'f', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'done' },
      ],
    });
    expect(res.ok).toBe(true);
  });

  it('captures tools, sampling, and streaming controls', () => {
    const res = parseChatRequest({
      ...valid,
      stream: true,
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: 'auto',
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.stream).toBe(true);
      expect(res.request.maxTokens).toBe(100);
      expect(res.request.temperature).toBe(0.5);
      expect(res.request.topP).toBe(0.9);
      expect(res.request.toolChoice).toBe('auto');
    }
  });
});

describe('parseChatRequest — invalid', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['invalid JSON', '{ not json', /not valid JSON/],
    ['non-object body', 5, /must be a JSON object/],
    ['missing model', { messages: valid.messages }, /model: Field required/],
    ['missing messages', { model: 'm' }, /messages: Field required/],
    [
      'empty messages',
      { model: 'm', messages: [] },
      /messages: Field required/,
    ],
    [
      'bad role',
      { model: 'm', messages: [{ role: 'robot', content: 'x' }] },
      /role: must be one of/,
    ],
    [
      'tool message without tool_call_id',
      { model: 'm', messages: [{ role: 'tool', content: 'x' }] },
      /tool_call_id: Field required/,
    ],
    [
      'missing content without tool_calls',
      { model: 'm', messages: [{ role: 'assistant' }] },
      /content: Field required/,
    ],
    ['non-array tools', { ...valid, tools: {} }, /tools: must be an array/],
    [
      'non-positive max_tokens',
      { ...valid, max_tokens: 0 },
      /max_tokens: must be a positive integer/,
    ],
    [
      'non-boolean stream',
      { ...valid, stream: 'y' },
      /stream: must be a boolean/,
    ],
  ];

  it.each(cases)('rejects %s', (_label, body, pattern) => {
    const res = parseChatRequest(body);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.error.error.type).toBe('invalid_request_error');
      expect(res.error.error.message).toMatch(pattern);
    }
  });
});

describe('buildChatCompletion', () => {
  it('renders a text completion as a golden object', () => {
    const result: CanonicalChatResult = {
      id: 'chatcmpl-x',
      model: 'gpt-4o',
      created: 1_700_000_000,
      finishReason: 'stop',
      text: 'hello',
      usage: { promptTokens: 12, completionTokens: 9 },
    };
    expect(
      buildChatCompletion(result, { genId: seqIdGen(), now: fixedNow }),
    ).toEqual({
      id: 'chatcmpl-x',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
    });
  });

  it('renders tool calls with content null and a tool_calls finish', () => {
    const obj = buildChatCompletion(
      {
        model: 'gpt-4o',
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'call_1', name: 'get_time', arguments: '{"tz":"UTC"}' },
        ],
      },
      { genId: seqIdGen(), now: fixedNow },
    );
    const choice = (obj.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
        },
      ],
    });
    expect(obj.id).toBe('chatcmpl-id1');
  });

  it('includes cached and reasoning usage detail when present', () => {
    expect(
      renderChatUsage({
        promptTokens: 100,
        completionTokens: 40,
        cachedTokens: 25,
        reasoningTokens: 12,
      }),
    ).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 12 },
    });
  });
});

function parseSse(
  transcript: string,
): Array<Record<string, unknown> | '[DONE]'> {
  return transcript
    .split('\n\n')
    .filter((r) => r.startsWith('data: '))
    .map((r) => {
      const payload = r.slice('data: '.length);
      return payload === '[DONE]'
        ? ('[DONE]' as const)
        : (JSON.parse(payload) as Record<string, unknown>);
    });
}

describe('encodeChatStream', () => {
  it('emits role, content, finish, and [DONE] in order', () => {
    const transcript = encodeChatStream(
      [
        { type: 'start', model: 'gpt-4o', id: 'chatcmpl-s' },
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        {
          type: 'finish',
          reason: 'stop',
          usage: { promptTokens: 5, completionTokens: 2 },
        },
      ],
      { genId: seqIdGen(), now: fixedNow },
    );
    const records = parseSse(transcript);
    expect(records[records.length - 1]).toBe('[DONE]');
    const chunks = records.filter(
      (r): r is Record<string, unknown> => r !== '[DONE]',
    );
    const deltas = chunks.map(
      (c) => (c.choices as Array<{ delta: Record<string, unknown> }>)[0]?.delta,
    );
    expect(deltas[0]).toEqual({ role: 'assistant' });
    expect(deltas[1]).toEqual({ content: 'Hel' });
    expect(deltas[2]).toEqual({ content: 'lo' });
    // finish chunk with empty delta + finish_reason
    const finishChunk = chunks[3];
    expect(
      (finishChunk.choices as Array<{ finish_reason: string }>)[0]
        .finish_reason,
    ).toBe('stop');
    // usage trailer chunk with empty choices
    const usageChunk = chunks[4];
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toMatchObject({ total_tokens: 7 });
    // every chunk repeats the same id/model
    expect(chunks.every((c) => c.id === 'chatcmpl-s')).toBe(true);
  });

  it('streams tool call id/name then argument deltas', () => {
    const events: ChatStreamEvent[] = [
      { type: 'start', model: 'gpt-4o' },
      { type: 'tool_call_start', index: 0, id: 'call_1', name: 'get_time' },
      { type: 'tool_args', index: 0, delta: '{"tz":' },
      { type: 'tool_args', index: 0, delta: '"UTC"}' },
      { type: 'finish', reason: 'tool_calls' },
    ];
    const chunks = parseSse(
      encodeChatStream(events, { genId: seqIdGen(), now: fixedNow }),
    ).filter((r): r is Record<string, unknown> => r !== '[DONE]');
    const toolDeltas = chunks
      .map(
        (c) =>
          (c.choices as Array<{ delta: { tool_calls?: unknown } }>)[0]?.delta,
      )
      .filter((d) => d.tool_calls);
    expect(toolDeltas[0].tool_calls).toEqual([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'get_time', arguments: '' },
      },
    ]);
    expect(toolDeltas[1].tool_calls).toEqual([
      { index: 0, function: { arguments: '{"tz":' } },
    ]);
  });

  it('enforces ordering invariants', () => {
    const enc = new ChatChunkEncoder({ genId: seqIdGen(), now: fixedNow });
    expect(() => enc.encode({ type: 'text', text: 'x' })).toThrow(
      /before stream start/,
    );
    enc.encode({ type: 'start', model: 'm' });
    expect(() => enc.encode({ type: 'start', model: 'm' })).toThrow(
      /more than once/,
    );
    enc.encode({ type: 'finish', reason: 'stop' });
    expect(enc.isDone).toBe(true);
    expect(() => enc.encode({ type: 'text', text: 'x' })).toThrow(
      /no events may follow/,
    );
  });

  it('requires the script to terminate with finish', () => {
    expect(() =>
      encodeChatStream([{ type: 'start', model: 'm' }], {
        genId: seqIdGen(),
        now: fixedNow,
      }),
    ).toThrow(/did not terminate/);
  });
});
