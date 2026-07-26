/**
 * Unit tests for the Z.ai GLM adapter and extensions (AIPP-9, 9.1).
 */

import { describe, it, expect } from 'vitest';
import { assertAdapterConformance } from '../conformance.js';
import {
  createZaiAdapter,
  extractZaiUsage,
} from '../../../src/providers/zai/adapter.js';
import {
  extractGlmRequestExtensions,
  extractGlmResponseExtras,
  extractGlmUsageExtras,
  extractGlmReasoningContent,
} from '../../../src/providers/zai/extensions.js';

function adapter() {
  return createZaiAdapter({ env: { ZAI_API_KEY: 'zk' } as NodeJS.ProcessEnv });
}

describe('adapter conformance', () => {
  it('satisfies the ProviderAdapter contract', () => {
    assertAdapterConformance(adapter());
    expect(adapter().id).toBe('zai');
    expect(adapter().upstreamProtocols).toEqual(['openai_chat']);
    expect(adapter().capabilities).toMatchObject({
      reasoning: true,
      promptCaching: true,
    });
    expect(adapter().resolveBaseUrl()).toBe('https://api.z.ai/api/paas/v4');
  });
});

describe('GLM request extensions', () => {
  it('extracts typed thinking / reasoning_effort / tool_stream', () => {
    expect(
      extractGlmRequestExtensions({
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
        tool_stream: true,
        model: 'glm-5.2',
      }),
    ).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      tool_stream: true,
    });
  });

  it('ignores malformed extension fields', () => {
    expect(
      extractGlmRequestExtensions({
        thinking: { type: 'maybe' },
        reasoning_effort: 5,
        tool_stream: 'yes',
      }),
    ).toEqual({});
  });

  it('serializeRequest forwards GLM extensions verbatim with bearer auth', () => {
    const req = adapter().serializeRequest({
      model: 'glm-5.2',
      stream: false,
      body: {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled' },
        reasoning_effort: 'medium',
        tool_stream: true,
      },
    });
    expect(req.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(req.headers.authorization).toBe('Bearer zk');
    const sent = JSON.parse(req.body ?? '{}');
    expect(sent.thinking).toEqual({ type: 'enabled' });
    expect(sent.reasoning_effort).toBe('medium');
    expect(sent.tool_stream).toBe(true);
  });

  it('prefers a client Authorization passthrough over the env key', () => {
    const req = adapter().serializeRequest({
      model: 'glm-5.2',
      stream: false,
      body: {},
      headers: { authorization: 'Bearer client-key' },
    });
    expect(req.headers.authorization).toBe('Bearer client-key');
  });
});

describe('GLM response extras', () => {
  it('captures request id, reasoning_content, and namespaced usage', () => {
    const body = {
      id: 'glm-resp-1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'answer',
            reasoning_content: 'because',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
        glm_web_search_count: 2,
      },
    };
    const extras = extractGlmResponseExtras(body, 'req-header-id');
    expect(extras).toEqual({
      requestId: 'req-header-id',
      reasoningContent: 'because',
      usageExtras: { 'zai.glm_web_search_count': 2 },
    });
  });

  it('falls back to the body id when no header id is present', () => {
    expect(
      extractGlmResponseExtras({ id: 'glm-resp-2' }, undefined).requestId,
    ).toBe('glm-resp-2');
  });

  it('reads reasoning_content from a streaming delta', () => {
    expect(
      extractGlmReasoningContent({
        choices: [{ delta: { reasoning_content: 'streamed' } }],
      }),
    ).toBe('streamed');
  });

  it('namespaces only non-standard numeric usage fields', () => {
    expect(
      extractGlmUsageExtras({
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
        glm_cached_blocks: 7,
      }),
    ).toEqual({ 'zai.glm_cached_blocks': 7 });
  });
});

describe('usage extraction and parseResponse', () => {
  it('extracts cached prompt tokens and namespaced GLM counters', () => {
    expect(
      extractZaiUsage({
        usage: {
          prompt_tokens: 20,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 12 },
          completion_tokens_details: { reasoning_tokens: 3 },
          glm_router_calls: 1,
        },
      }),
    ).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 12,
      reasoningTokens: 3,
      extra: { 'zai.glm_router_calls': 1 },
    });
  });

  it('parseResponse captures the request id and leaves reasoning in the body', () => {
    const parsed = adapter().parseResponse({
      status: 200,
      headers: { 'x-request-id': 'zai-req-1' },
      body: JSON.stringify({
        id: 'glm-1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hi',
              reasoning_content: 'secret-reasoning',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    });
    expect(parsed.providerRequestId).toBe('zai-req-1');
    expect(parsed.stopReason).toBe('stop');
    // Reasoning text stays in the body for the 9.3 mapping; not in the usage.
    expect(JSON.stringify(parsed.usage)).not.toContain('secret-reasoning');
    expect(
      (
        parsed.body as {
          choices: Array<{ message: { reasoning_content: string } }>;
        }
      ).choices[0].message.reasoning_content,
    ).toBe('secret-reasoning');
  });
});
