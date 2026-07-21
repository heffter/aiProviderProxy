/**
 * Tests for the generic OpenAI-compatible adapter (epic AIPP-4, subtask 4.3).
 */

import { describe, it, expect } from 'vitest';
import {
  createOpenAICompatibleAdapter,
  OPENAI_COMPATIBLE_PROVIDERS,
  parseOpenAISse,
  registerOpenAICompatibleProviders,
} from '../../src/providers/openai-compatible.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { Transport } from '../../src/providers/types.js';
import { assertAdapterConformance } from './conformance.js';

const env = {
  XAI_API_KEY: 'xai-key',
  OPENROUTER_API_KEY: 'or-key',
} as NodeJS.ProcessEnv;

function adapter(id: string) {
  const params = OPENAI_COMPATIBLE_PROVIDERS.find((p) => p.id === id)!;
  return createOpenAICompatibleAdapter(params, { env });
}

describe('conformance for all eight providers', () => {
  it.each(OPENAI_COMPATIBLE_PROVIDERS.map((p) => p.id))(
    '%s passes the contract',
    (id) => {
      assertAdapterConformance(adapter(id));
    },
  );
});

describe('serializeRequest auth', () => {
  it('uses the env bearer key and the chat/completions URL', () => {
    const req = adapter('xai').serializeRequest({
      model: 'grok-4',
      stream: false,
      body: { model: 'grok-4' },
    });
    expect(req.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Bearer xai-key');
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('honours client passthrough only when the provider allows it', () => {
    const passthrough = { authorization: 'Bearer client-token' };
    // openrouter allows passthrough
    expect(
      adapter('openrouter').serializeRequest({
        model: 'm',
        stream: false,
        body: {},
        headers: passthrough,
      }).headers.authorization,
    ).toBe('Bearer client-token');
    // xai does not: it uses the env key
    expect(
      adapter('xai').serializeRequest({
        model: 'm',
        stream: false,
        body: {},
        headers: passthrough,
      }).headers.authorization,
    ).toBe('Bearer xai-key');
  });

  it('honours a baseUrl override', () => {
    const req = adapter('groq').serializeRequest(
      { model: 'm', stream: false, body: {} },
      { baseUrl: 'https://proxy.local/v1' },
    );
    expect(req.url).toBe('https://proxy.local/v1/chat/completions');
  });
});

describe('parseResponse usage and ids', () => {
  it('extracts usage, request id, response id and stop reason', () => {
    const parsed = adapter('groq').parseResponse({
      status: 200,
      headers: { 'x-request-id': 'req_123' },
      body: JSON.stringify({
        id: 'chatcmpl-abc',
        choices: [{ finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 8 },
        },
      }),
    });
    expect(parsed.providerRequestId).toBe('req_123');
    expect(parsed.providerResponseId).toBe('chatcmpl-abc');
    expect(parsed.stopReason).toBe('stop');
    expect(parsed.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 40,
      reasoningTokens: 8,
    });
  });
});

describe('parseStreamEvent', () => {
  it('parses OpenAI SSE chunks and [DONE]', () => {
    const events = parseOpenAISse(
      'data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('chat.completion.chunk');
    expect(events[1].event).toBe('done');
  });
});

describe('classifyError and registry', () => {
  it('classifies a 429 as rate limited', () => {
    expect(adapter('deepseek').classifyError({ status: 429 })).toBe(
      'provider_rate_limited',
    );
  });

  it('registers all eight providers without conflict', () => {
    const registry = new ProviderRegistry();
    registerOpenAICompatibleProviders(registry, { env });
    expect(registry.ids().sort()).toEqual(
      OPENAI_COMPATIBLE_PROVIDERS.map((p) => p.id).sort(),
    );
    // the misroute bug is gone: an unregistered provider does not resolve to openai
    expect(registry.has('openai')).toBe(false);
  });
});

describe('healthCheck', () => {
  it('is true on a <500 response and false when the transport throws', async () => {
    const ok: Transport = async () => ({
      status: 200,
      headers: {},
      body: '{}',
    });
    const boom: Transport = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await adapter('xai').healthCheck(ok)).toBe(true);
    expect(await adapter('xai').healthCheck(boom)).toBe(false);
  });
});
