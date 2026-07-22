/**
 * Tests for the OpenAI adapter (chat + responses) (epic AIPP-4, subtask 4.5).
 */

import { describe, it, expect } from 'vitest';
import {
  createOpenAIAdapter,
  extractOpenAIUsage,
  extractServiceTier,
  parseOpenAIStream,
} from '../../../src/providers/openai/index.js';
import { assertAdapterConformance } from '../conformance.js';

const env = { OPENAI_API_KEY: 'sk-openai-envkey' } as NodeJS.ProcessEnv;
const adapter = createOpenAIAdapter({ env });

describe('conformance', () => {
  it('passes the adapter contract', () => {
    assertAdapterConformance(adapter);
    expect(adapter.upstreamProtocols).toEqual([
      'openai_chat',
      'openai_responses',
    ]);
  });
});

describe('serializeRequest routes by upstream protocol', () => {
  it('defaults to /chat/completions with the env bearer key', () => {
    const req = adapter.serializeRequest({
      model: 'gpt-4o',
      stream: false,
      body: {},
    });
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-openai-envkey');
  });

  it('targets /responses for the responses protocol', () => {
    const req = adapter.serializeRequest({
      model: 'gpt-4o',
      stream: false,
      body: {},
      upstreamProtocol: 'openai_responses',
    });
    expect(req.url).toBe('https://api.openai.com/v1/responses');
  });

  it('honours client passthrough auth', () => {
    const req = adapter.serializeRequest({
      model: 'm',
      stream: false,
      body: {},
      headers: { authorization: 'Bearer client' },
    });
    expect(req.headers.authorization).toBe('Bearer client');
  });
});

describe('parseResponse — chat completions', () => {
  it('extracts usage, ids, finish_reason and service tier', () => {
    const parsed = adapter.parseResponse({
      status: 200,
      headers: { 'x-request-id': 'req_oa_1' },
      body: JSON.stringify({
        id: 'chatcmpl-1',
        service_tier: 'default',
        choices: [{ finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          prompt_tokens_details: { cached_tokens: 30 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      }),
    });
    expect(parsed.providerRequestId).toBe('req_oa_1');
    expect(parsed.providerResponseId).toBe('chatcmpl-1');
    expect(parsed.stopReason).toBe('stop');
    expect(parsed.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 30,
      reasoningTokens: 12,
    });
    expect(extractServiceTier(parsed.body)).toBe('default');
  });
});

describe('parseResponse — responses protocol', () => {
  it('uses the terminal status and the responses usage shape', () => {
    const parsed = adapter.parseResponse({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id: 'resp_1',
        status: 'completed',
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 64 },
          output_tokens_details: { reasoning_tokens: 20 },
        },
      }),
    });
    expect(parsed.providerResponseId).toBe('resp_1');
    expect(parsed.stopReason).toBe('completed');
    expect(parsed.usage).toMatchObject({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 64,
      reasoningTokens: 20,
    });
  });

  it('extractOpenAIUsage handles an incomplete responses result', () => {
    expect(
      extractOpenAIUsage({
        status: 'incomplete',
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
    ).toMatchObject({ inputTokens: 5, outputTokens: 0 });
  });
});

describe('parseOpenAIStream handles both protocols', () => {
  it('parses chat data-only chunks with [DONE]', () => {
    const events = parseOpenAIStream(
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    );
    expect(events[0].event).toBe('chat.completion.chunk');
    expect(events[1].event).toBe('done');
  });

  it('parses responses event+data blocks', () => {
    const events = parseOpenAIStream(
      'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n',
    );
    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.completed',
    ]);
  });
});

describe('classifyError', () => {
  it('classifies a 401 as auth', () => {
    expect(adapter.classifyError({ status: 401 })).toBe('provider_auth_error');
  });
});
