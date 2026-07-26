/**
 * Integration test: GLM (Z.ai) reasoning across the Messages surface (AIPP-9,
 * 9.3). Claude Code sends Anthropic Messages with a thinking budget; the gateway
 * routes glm-5.2 to Z.ai, maps thinking -> GLM controls on the request, and maps
 * GLM reasoning_content -> a thinking block on the response.
 */

import { describe, it, expect } from 'vitest';
import {
  createGateway,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import type { Transport } from '../../src/providers/types.js';

const env = { ZAI_API_KEY: 'zk' } as NodeJS.ProcessEnv;

function messagesPost(extra: Record<string, unknown>): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.2',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'solve it' }],
      ...extra,
    }),
  };
}

describe('GLM reasoning on the Messages surface', () => {
  it('maps the thinking budget to GLM controls and reasoning_content to a thinking block', async () => {
    let forwarded: Record<string, unknown> = {};
    const glmResponse = {
      id: 'glm-1',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'The answer is 42.',
            reasoning_content: 'Working through the steps...',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 6 },
    };
    const transport: Transport = async (req) => {
      expect(req.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
      forwarded = JSON.parse(req.body ?? '{}');
      return {
        status: 200,
        headers: { 'x-request-id': 'zai-1' },
        body: JSON.stringify(glmResponse),
      };
    };
    const gateway = createGateway({
      config: defaultConfig(),
      registry: buildProviderRegistry({ env }),
      transport,
    });

    const res = await gateway.handle(
      messagesPost({ thinking: { type: 'enabled', budget_tokens: 10_000 } }),
    );

    expect(res.status).toBe(200);
    // Request: thinking budget mapped to GLM controls.
    expect(forwarded.thinking).toEqual({ type: 'enabled' });
    expect(forwarded.reasoning_effort).toBe('medium');

    // Response: reasoning_content surfaced as a leading (unsigned) thinking block.
    const body = JSON.parse(res.body);
    expect(body.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Working through the steps...',
    });
    expect(body.content[0].signature).toBeUndefined();
    expect(body.content[1]).toEqual({
      type: 'text',
      text: 'The answer is 42.',
    });
  });

  it('adds no thinking block when GLM returns no reasoning', async () => {
    const transport: Transport = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id: 'glm-2',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'plain answer' },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    });
    const gateway = createGateway({
      config: defaultConfig(),
      registry: buildProviderRegistry({ env }),
      transport,
    });
    const res = await gateway.handle(messagesPost({}));
    const body = JSON.parse(res.body);
    expect(body.content[0]).toEqual({ type: 'text', text: 'plain answer' });
  });
});
