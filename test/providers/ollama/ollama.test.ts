/**
 * Unit tests for the Ollama adapter and translation (AIPP-8, 8.4).
 */

import { describe, it, expect } from 'vitest';
import { assertAdapterConformance } from '../conformance.js';
import {
  createOllamaAdapter,
  extractOllamaUsage,
  classifyOllamaError,
} from '../../../src/providers/ollama/adapter.js';
import {
  chatToOllamaRequest,
  ollamaResponseToChat,
  ollamaChunkToChat,
  ollamaFinishToChat,
} from '../../../src/providers/ollama/translate.js';

const seqIdGen = () => {
  let n = 0;
  return () => `id${(n += 1)}`;
};
const fixedNow = () => 1_700_000_000_000;

function adapter() {
  return createOllamaAdapter({ genId: seqIdGen(), now: fixedNow });
}

describe('adapter conformance', () => {
  it('satisfies the ProviderAdapter contract', () => {
    assertAdapterConformance(adapter());
    expect(adapter().id).toBe('ollama');
    expect(adapter().upstreamProtocols).toEqual(['ollama']);
    expect(adapter().resolveBaseUrl()).toBe('http://127.0.0.1:11434');
  });
});

describe('chatToOllamaRequest', () => {
  it('maps messages and moves sampling under options', () => {
    const body = chatToOllamaRequest({
      model: 'llama3.1',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 64,
      temperature: 0.5,
      top_p: 0.9,
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body.options).toEqual({
      num_predict: 64,
      temperature: 0.5,
      top_p: 0.9,
    });
  });

  it('parses assistant tool_call arguments into objects for Ollama', () => {
    const body = chatToOllamaRequest({
      model: 'llama3.1',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
            },
          ],
        },
      ],
    });
    expect(body.messages[0].tool_calls).toEqual([
      { function: { name: 'get_time', arguments: { tz: 'UTC' } } },
    ]);
  });
});

describe('ollama response translation', () => {
  it('maps message + eval counts to a chat.completion', () => {
    const chat = ollamaResponseToChat(
      {
        model: 'llama3.1',
        message: { role: 'assistant', content: 'Hello.' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 6,
        eval_count: 2,
      },
      'llama3.1',
      'chatcmpl-x',
      1_700_000_004,
    );
    expect(chat).toEqual({
      id: 'chatcmpl-x',
      object: 'chat.completion',
      created: 1_700_000_004,
      model: 'llama3.1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
    });
  });

  it('maps tool_calls (object args -> JSON string) with a tool_calls finish', () => {
    const chat = ollamaResponseToChat(
      {
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'get_time', arguments: { tz: 'UTC' } } },
          ],
        },
        done: true,
      },
      'llama3.1',
      'id',
      1,
    );
    const choice = (chat.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(
      (
        choice.message as {
          tool_calls: Array<{ function: { arguments: string } }>;
        }
      ).tool_calls[0].function.arguments,
    ).toBe('{"tz":"UTC"}');
  });

  it('maps done_reason length to finish length', () => {
    expect(ollamaFinishToChat('length')).toBe('length');
    expect(ollamaFinishToChat(undefined)).toBe('stop');
  });
});

describe('adapter serialize/parse/stream/classify', () => {
  it('serializes to /api/chat', () => {
    const req = adapter().serializeRequest({
      model: 'llama3.1',
      stream: false,
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(req.url).toBe('http://127.0.0.1:11434/api/chat');
    const parsed = JSON.parse(req.body ?? '{}');
    expect(parsed.model).toBe('llama3.1');
    expect(parsed.stream).toBe(false);
  });

  it('parseResponse yields a chat.completion with usage', () => {
    const parsed = adapter().parseResponse({
      status: 200,
      headers: {},
      body: JSON.stringify({
        model: 'llama3.1',
        message: { role: 'assistant', content: 'hi' },
        done: true,
        prompt_eval_count: 3,
        eval_count: 1,
      }),
    });
    expect((parsed.body as { object: string }).object).toBe('chat.completion');
    expect(parsed.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(parsed.stopReason).toBe('stop');
  });

  it('parseStreamEvent translates NDJSON lines to chat chunks', () => {
    const events = adapter().parseStreamEvent(
      '{"message":{"role":"assistant","content":"He"},"done":false}\n' +
        '{"message":{"role":"assistant","content":"llo"},"done":false}\n' +
        '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n',
    );
    expect(events).toHaveLength(3);
    expect(
      (events[0].data as { choices: Array<{ delta: { content: string } }> })
        .choices[0].delta.content,
    ).toBe('He');
    expect(
      (events[2].data as { choices: Array<{ finish_reason: string }> })
        .choices[0].finish_reason,
    ).toBe('stop');
  });

  it('ollamaChunkToChat ignores blank/invalid lines', () => {
    expect(ollamaChunkToChat('')).toBeNull();
    expect(ollamaChunkToChat('not json')).toBeNull();
  });

  it('classifies errors and extracts usage', () => {
    expect(classifyOllamaError({ status: 503 })).toBe('provider_overloaded');
    expect(
      classifyOllamaError({
        cause: Object.assign(new Error(), { name: 'AbortError' }),
      }),
    ).toBe('client_cancelled');
    expect(classifyOllamaError({ cause: new Error('ECONNREFUSED') })).toBe(
      'provider_connection_error',
    );
    expect(extractOllamaUsage({ prompt_eval_count: 5, eval_count: 2 })).toEqual(
      { inputTokens: 5, outputTokens: 2 },
    );
  });
});
