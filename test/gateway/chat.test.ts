/**
 * Integration tests for the OpenAI Chat Completions surface (epic AIPP-8).
 *
 * Drives /v1/chat/completions against mock transports: the native OpenAI
 * verbatim path, the Anthropic-translated path (with the cache-token and
 * thinking-diagnostic fixes), streaming, and tool-router enforcement.
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
import { ToolAuthorizer } from '../../src/tools/index.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-envkey',
  OPENAI_API_KEY: 'sk-openai-envkey',
} as NodeJS.ProcessEnv;

function post(
  model: string,
  extra: Record<string, unknown> = {},
): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      'x-claude-code-session-id': 'sess-1',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hello' }],
      ...extra,
    }),
  };
}

function harness(transport: Transport, toolAuthorizer?: ToolAuthorizer) {
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
    toolAuthorizer,
  });
  return { gateway, events, sinks, outbox };
}

describe('native OpenAI chat passthrough', () => {
  it('forwards to /chat/completions and returns the body verbatim', async () => {
    const completion = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    const transport: Transport = async (req) => {
      expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
      return {
        status: 200,
        headers: { 'x-request-id': 'req_oai' },
        body: JSON.stringify(completion),
      };
    };
    const { gateway, events } = harness(transport);
    const res = await gateway.handle(post('gpt-4o'));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(completion); // verbatim
    expect(events[0]).toMatchObject({ provider: 'openai', eventId: 'req_oai' });
  });
});

describe('Anthropic-translated chat path', () => {
  const anthropicResponse = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'do-not-export' },
      { type: 'text', text: 'Hello from Claude.' },
    ],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 9,
      cache_creation_input_tokens: 6,
    },
  };

  it('translates, preserves cache tokens (fix 1), and diagnoses thinking (fix 2)', async () => {
    let forwarded: unknown;
    const transport: Transport = async (req) => {
      expect(req.url).toBe('https://api.anthropic.com/v1/messages');
      forwarded = JSON.parse(req.body ?? '{}');
      return {
        status: 200,
        headers: { 'request-id': 'req_ant' },
        body: JSON.stringify(anthropicResponse),
      };
    };
    const { gateway, events } = harness(transport);
    const res = await gateway.handle(post('claude-sonnet-4'));

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message).toEqual({
      role: 'assistant',
      content: 'Hello from Claude.',
    });
    // Fix 1: cache-read tokens surface in the chat body usage...
    expect(body.usage.prompt_tokens_details).toEqual({ cached_tokens: 9 });
    // ...and in the canonical usage event (adapter-extracted cache split).
    expect(events[0]).toMatchObject({
      provider: 'anthropic',
      cacheReadTokens: 9,
    });
    // Fix 2: dropped thinking is diagnosed via a namespaced header, not leaked.
    expect(res.headers['x-aipp-thinking-diagnostics']).toBe('thinking=1');
    expect(res.body).not.toContain('do-not-export');
    // The request was translated to Anthropic shape (system/messages/max_tokens).
    expect((forwarded as { max_tokens: number }).max_tokens).toBeGreaterThan(0);
  });

  it('serves a streaming chat request as a chat.completion SSE transcript', async () => {
    const transport: Transport = async () => ({
      status: 200,
      headers: { 'request-id': 'req_ant2' },
      body: JSON.stringify(anthropicResponse),
    });
    const { gateway } = harness(transport);
    const res = await gateway.handle(post('claude-sonnet-4', { stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('"object":"chat.completion.chunk"');
    expect(res.body).toContain('"content":"Hello from Claude."');
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('Gemini-translated chat path', () => {
  const geminiResponse = {
    candidates: [
      {
        content: { parts: [{ text: 'Hi from Gemini.' }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 8,
      candidatesTokenCount: 3,
      totalTokenCount: 11,
    },
    modelVersion: 'gemini-1.5-pro-002',
  };

  it('routes to generateContent and returns a chat.completion', async () => {
    const transport: Transport = async (req) => {
      expect(req.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
      );
      // Body was translated to the Gemini shape.
      expect(JSON.parse(req.body ?? '{}').contents).toBeDefined();
      return { status: 200, headers: {}, body: JSON.stringify(geminiResponse) };
    };
    const { gateway, events } = harness(transport);
    const res = await gateway.handle(post('gemini-1.5-pro'));

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('gemini-1.5-pro'); // stamped with the routed model
    expect(body.choices[0].message).toEqual({
      role: 'assistant',
      content: 'Hi from Gemini.',
    });
    expect(body.usage).toMatchObject({
      prompt_tokens: 8,
      completion_tokens: 3,
    });
    expect(events[0]).toMatchObject({
      provider: 'google',
      inputTokens: 8,
      outputTokens: 3,
    });
  });

  it('serves a streaming client as a buffered chat SSE transcript', async () => {
    const transport: Transport = async (req) => {
      // The upstream is always requested non-streaming for translated paths.
      expect(req.url).toContain(':generateContent');
      expect(req.url).not.toContain(':streamGenerateContent');
      return { status: 200, headers: {}, body: JSON.stringify(geminiResponse) };
    };
    const { gateway } = harness(transport);
    const res = await gateway.handle(post('gemini-1.5-pro', { stream: true }));
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('"content":"Hi from Gemini."');
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('tool-router authorization', () => {
  function toolPost(names: string[]): GatewayRequest {
    return post('gpt-4o', {
      tools: names.map((name) => ({ type: 'function', function: { name } })),
    });
  }

  it('strips denied function tools from the forwarded body', async () => {
    let forwarded: unknown;
    const transport: Transport = async (req) => {
      forwarded = JSON.parse(req.body ?? '{}');
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        }),
      };
    };
    const authorizer = new ToolAuthorizer({ enabled: true });
    const { gateway } = harness(transport, authorizer);
    const req = toolPost(['bash', 'web_search']);
    req.headers['x-task-type'] = 'code'; // allows bash, denies web_search
    const res = await gateway.handle(req);

    expect(res.status).toBe(200);
    expect(res.headers['x-aipp-tools-denied']).toBe('web_search');
    const names = (
      forwarded as { tools: Array<{ function: { name: string } }> }
    ).tools.map((t) => t.function.name);
    expect(names).toEqual(['bash']);
  });

  it('rejects with 403 when every requested tool is denied', async () => {
    const authorizer = new ToolAuthorizer({ enabled: true });
    const { gateway, events } = harness(async () => {
      throw new Error('transport must not be called');
    }, authorizer);
    const req = toolPost(['web_search']);
    req.headers['x-task-type'] = 'code';
    const res = await gateway.handle(req);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.type).toBe('permission_error');
    expect(events[0]).toMatchObject({ outcome: 'policy_rejected' });
  });
});

describe('chat errors', () => {
  it('400s a malformed request', async () => {
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: '{}',
    }));
    const res = await gateway.handle({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {},
      body: JSON.stringify({ model: 'gpt-4o' }), // no messages
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.type).toBe('invalid_request_error');
  });

  it('maps a 500 upstream to a server_error and emits a failure event', async () => {
    const transport: Transport = async () => ({
      status: 500,
      headers: {},
      body: JSON.stringify({ error: { type: 'server_error' } }),
    });
    const { gateway, events } = harness(transport);
    const res = await gateway.handle(post('gpt-4o'));
    expect(res.status).toBeGreaterThanOrEqual(429);
    expect(events[0]).toMatchObject({ success: false });
  });
});
