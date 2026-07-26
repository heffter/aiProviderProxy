/**
 * Epic AIPP-9 acceptance: Z.ai GLM fixture suite (subtask 9.4; FR-PA-ZAI-010).
 *
 * Exercises glm-5.2 from both client protocols against synthetic GLM upstream
 * responses (text, tools, reasoning; non-streamed and streamed):
 *
 *   - Chat Completions: Z.ai speaks Chat Completions natively, so the surface
 *     forwards the GLM response verbatim (reasoning_content preserved) while the
 *     usage event captures cached prompt tokens and namespaced GLM counters.
 *   - Messages: the request is translated to Anthropic; reasoning_content is
 *     surfaced as a thinking block (covered in glm-messages.test.ts; text/tools
 *     here).
 *
 * Live validation against a real ZAI_API_KEY is a manual checklist in
 * docs/integrations/zai.md.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  createGateway,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import { EventSinkRegistry } from '../../src/lifecycle/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { Transport } from '../../src/providers/types.js';

const env = { ZAI_API_KEY: 'zk' } as NodeJS.ProcessEnv;

function harness(transport: Transport) {
  const events: CanonicalUsageEvent[] = [];
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onLogicalRequestFinal: (e) => {
      events.push(e);
    },
  });
  const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
  const gateway = createGateway({
    config: defaultConfig(),
    registry: buildProviderRegistry({ env }),
    transport,
    sinks,
    outbox,
  });
  return { gateway, events };
}

function chatPost(extra: Record<string, unknown> = {}): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    }),
  };
}

describe('Z.ai GLM from Chat Completions (verbatim)', () => {
  it('text: forwards the GLM completion and captures cached + GLM usage', async () => {
    const glm = {
      id: 'glm-t',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 6 },
        glm_router_calls: 1,
      },
    };
    const { gateway, events } = harness(async (req) => {
      expect(req.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
      return {
        status: 200,
        headers: { 'x-request-id': 'zai-t' },
        body: JSON.stringify(glm),
      };
    });
    const res = await gateway.handle(chatPost());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(glm); // verbatim
    expect(events[0]).toMatchObject({
      provider: 'zai',
      eventId: 'zai-t',
      cacheReadTokens: 6,
    });
  });

  it('tools: forwards a GLM tool_calls completion verbatim', async () => {
    const glm = {
      id: 'glm-tool',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'f', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    };
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(glm),
    }));
    const res = await gateway.handle(
      chatPost({ tools: [{ type: 'function', function: { name: 'f' } }] }),
    );
    expect(JSON.parse(res.body).choices[0].finish_reason).toBe('tool_calls');
  });

  it('reasoning: preserves reasoning_content in the verbatim chat body', async () => {
    const glm = {
      id: 'glm-r',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'answer',
            reasoning_content: 'chain of thought',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(glm),
    }));
    const res = await gateway.handle(
      chatPost({ thinking: { type: 'enabled' }, reasoning_effort: 'high' }),
    );
    expect(JSON.parse(res.body).choices[0].message.reasoning_content).toBe(
      'chain of thought',
    );
  });

  it('streamed: forwards the GLM SSE transcript as text/event-stream', async () => {
    const sse =
      'data: {"id":"glm-s","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"He"}}]}\n\n' +
      'data: {"id":"glm-s","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: sse,
    }));
    const res = await gateway.handle(chatPost({ stream: true }));
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('chat.completion.chunk');
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('Z.ai GLM from Messages (translated)', () => {
  function messagesPost(extra: Record<string, unknown> = {}): GatewayRequest {
    return {
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.2',
        max_tokens: 512,
        messages: [{ role: 'user', content: 'hi' }],
        ...extra,
      }),
    };
  }

  it('text: translates the GLM completion to an Anthropic message', async () => {
    const { gateway, events } = harness(async () => ({
      status: 200,
      headers: { 'x-request-id': 'zai-m' },
      body: JSON.stringify({
        id: 'glm-m',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'translated' },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    }));
    const res = await gateway.handle(messagesPost());
    const body = JSON.parse(res.body);
    expect(body.type).toBe('message');
    expect(body.content[0]).toEqual({ type: 'text', text: 'translated' });
    expect(events[0]).toMatchObject({ provider: 'zai' });
  });

  it('tools: translates GLM tool_calls to an Anthropic tool_use block', async () => {
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id: 'glm-mt',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'tc1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":1}' },
                },
              ],
            },
          },
        ],
      }),
    }));
    const res = await gateway.handle(
      messagesPost({
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      }),
    );
    const body = JSON.parse(res.body);
    const toolUse = body.content.find(
      (b: { type: string }) => b.type === 'tool_use',
    );
    expect(toolUse).toMatchObject({ name: 'lookup', id: 'tc1' });
  });
});
