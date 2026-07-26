/**
 * Unit tests for the Google Gemini adapter and translation (AIPP-8, 8.3).
 */

import { describe, it, expect } from 'vitest';
import { assertAdapterConformance } from '../conformance.js';
import {
  createGoogleAdapter,
  extractGeminiUsage,
  classifyGeminiError,
} from '../../../src/providers/google/adapter.js';
import {
  chatToGeminiRequest,
  geminiResponseToChat,
  geminiUsage,
  geminiFinishToChat,
} from '../../../src/providers/google/translate.js';

const seqIdGen = () => {
  let n = 0;
  return () => `id${(n += 1)}`;
};
const fixedNow = () => 1_700_000_000_000;

function adapter() {
  return createGoogleAdapter({
    env: { GOOGLE_API_KEY: 'k' } as NodeJS.ProcessEnv,
    genId: seqIdGen(),
    now: fixedNow,
  });
}

describe('adapter conformance', () => {
  it('satisfies the ProviderAdapter contract', () => {
    assertAdapterConformance(adapter());
    expect(adapter().id).toBe('google');
    expect(adapter().upstreamProtocols).toEqual(['gemini']);
  });
});

describe('chatToGeminiRequest', () => {
  it('maps system to systemInstruction and messages to contents', () => {
    const body = chatToGeminiRequest({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      max_tokens: 128,
      temperature: 0.4,
    });
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ]);
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 128,
      temperature: 0.4,
    });
  });

  it('maps tools to functionDeclarations and tool calls/results', () => {
    const body = chatToGeminiRequest({
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
        {
          role: 'tool',
          name: 'get_time',
          tool_call_id: 'c1',
          content: '12:00',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_time',
            description: 'time',
            parameters: { type: 'object' },
          },
        },
      ],
    });
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_time',
            description: 'time',
            parameters: { type: 'object' },
          },
        ],
      },
    ]);
    expect(body.contents[0].parts[0]).toEqual({
      functionCall: { name: 'get_time', args: { tz: 'UTC' } },
    });
    expect(body.contents[1].parts[0]).toEqual({
      functionResponse: { name: 'get_time', response: { content: '12:00' } },
    });
  });
});

describe('gemini response translation', () => {
  it('maps candidates + usageMetadata to a chat.completion', () => {
    const chat = geminiResponseToChat(
      {
        candidates: [
          { content: { parts: [{ text: 'Hello.' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 2,
          totalTokenCount: 10,
        },
      },
      'gemini-1.5-pro',
      'chatcmpl-x',
      1_700_000_003,
    );
    expect(chat).toEqual({
      id: 'chatcmpl-x',
      object: 'chat.completion',
      created: 1_700_000_003,
      model: 'gemini-1.5-pro',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    });
  });

  it('maps a functionCall part to a tool_calls choice', () => {
    const chat = geminiResponseToChat(
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'get_time', args: { tz: 'UTC' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
      'gemini-1.5-pro',
      'id',
      1,
    );
    const choice = (chat.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(
      (choice.message as { tool_calls: Array<{ function: { name: string } }> })
        .tool_calls[0].function.name,
    ).toBe('get_time');
  });

  it('maps finish reasons and cached usage', () => {
    expect(geminiFinishToChat('MAX_TOKENS')).toBe('length');
    expect(geminiFinishToChat('SAFETY')).toBe('content_filter');
    expect(
      geminiUsage({
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        cachedContentTokenCount: 6,
      }),
    ).toMatchObject({ prompt_tokens_details: { cached_tokens: 6 } });
  });
});

describe('adapter serialize/parse/classify', () => {
  it('serializes to the generateContent endpoint with the api key header', () => {
    const req = adapter().serializeRequest({
      model: 'gemini-1.5-pro',
      stream: false,
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
    );
    expect(req.headers['x-goog-api-key']).toBe('k');
    expect(JSON.parse(req.body ?? '{}').contents).toBeDefined();
  });

  it('targets streamGenerateContent when streaming', () => {
    const req = adapter().serializeRequest({
      model: 'gemini-1.5-pro',
      stream: true,
      body: { messages: [] },
    });
    expect(req.url).toContain(':streamGenerateContent');
  });

  it('parseResponse yields a chat.completion with usage', () => {
    const parsed = adapter().parseResponse({
      status: 200,
      headers: {},
      body: JSON.stringify({
        candidates: [
          { content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
        modelVersion: 'gemini-1.5-pro',
      }),
    });
    expect((parsed.body as { object: string }).object).toBe('chat.completion');
    expect(parsed.usage).toEqual({
      inputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: undefined,
    });
    expect(parsed.stopReason).toBe('stop');
  });

  it('parseStreamEvent translates gemini SSE chunks to chat chunks', () => {
    const events = adapter().parseStreamEvent(
      'data: {"candidates":[{"content":{"parts":[{"text":"He"}]}}]}\n\n' +
        'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]},"finishReason":"STOP"}]}\n\n',
    );
    expect(events).toHaveLength(2);
    expect(
      (events[0].data as { choices: Array<{ delta: { content: string } }> })
        .choices[0].delta.content,
    ).toBe('He');
    expect(
      (events[1].data as { choices: Array<{ finish_reason: string }> })
        .choices[0].finish_reason,
    ).toBe('stop');
  });

  it('classifies errors and extracts usage', () => {
    expect(classifyGeminiError({ status: 429 })).toBe('provider_rate_limited');
    expect(classifyGeminiError({ status: 403 })).toBe('provider_auth_error');
    expect(
      classifyGeminiError({
        cause: Object.assign(new Error(), { name: 'AbortError' }),
      }),
    ).toBe('client_cancelled');
    expect(
      extractGeminiUsage({
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
    ).toEqual({ inputTokens: 5, outputTokens: 2, cacheReadTokens: undefined });
  });
});
