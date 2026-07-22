/**
 * Integration tests for the gateway server (epic AIPP-6, subtask 6.2).
 *
 * Drives the full pipeline (parse -> resolve -> dispatch -> translate -> emit)
 * against mock transports, asserting the Anthropic fast path, the translated
 * OpenAI path, error mapping, and that a content-free usage event reaches the
 * sinks and outbox.
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

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-envkey',
  OPENAI_API_KEY: 'sk-openai-envkey',
} as NodeJS.ProcessEnv;

function post(
  model: string,
  extra: Record<string, unknown> = {},
): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-claude-code-session-id': 'sess-1',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    }),
  };
}

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
  return { gateway, events, sinks, outbox };
}

describe('health', () => {
  it('responds ok', async () => {
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: '{}',
    }));
    const res = await gateway.handle({
      method: 'GET',
      url: '/health',
      headers: {},
      body: '',
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok' });
  });
});

describe('Anthropic fast path', () => {
  it('forwards a native model verbatim and emits a usage event', async () => {
    const anthropicResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_creation: { ephemeral_5m_input_tokens: 8 },
      },
    };
    const transport: Transport = async (req) => {
      expect(req.url).toBe('https://api.anthropic.com/v1/messages'); // fast path target
      return {
        status: 200,
        headers: { 'request-id': 'req_ant' },
        body: JSON.stringify(anthropicResponse),
      };
    };
    const { gateway, events, sinks, outbox } = harness(transport);

    const res = await gateway.handle(post('claude-sonnet-4'));
    await sinks.drain();

    expect(res.status).toBe(200);
    expect(res.headers['request-id']).toBe('req_ant');
    expect(JSON.parse(res.body)).toMatchObject({
      id: 'msg_1',
      stop_reason: 'end_turn',
    }); // verbatim
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'anthropic',
      eventId: 'req_ant',
      inputTokens: 10,
      outputTokens: 4,
      cacheWriteShortTokens: 8,
    });
    expect(outbox.counts().pending).toBe(1);
  });
});

describe('translated OpenAI path', () => {
  it('translates the request and the response and emits an openai event', async () => {
    const openaiResponse = {
      id: 'chatcmpl-1',
      choices: [
        { finish_reason: 'stop', message: { content: 'translated hello' } },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    };
    const transport: Transport = async (req) => {
      expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
      return {
        status: 200,
        headers: { 'x-request-id': 'req_oai' },
        body: JSON.stringify(openaiResponse),
      };
    };
    const { gateway, events } = harness(transport);

    const res = await gateway.handle(post('gpt-4o'));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'gpt-4o',
      stop_reason: 'end_turn',
    });
    expect(body.content[0]).toEqual({ type: 'text', text: 'translated hello' });
    expect(events[0]).toMatchObject({
      provider: 'openai',
      eventId: 'req_oai',
      inputTokens: 12,
      outputTokens: 5,
    });
  });
});

describe('real HTTP boot (listen)', () => {
  it('binds a socket and serves /health and /v1/messages', async () => {
    const anthropicResponse = {
      id: 'msg_live',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'live' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    const transport: Transport = async () => ({
      status: 200,
      headers: { 'request-id': 'req_live' },
      body: JSON.stringify(anthropicResponse),
    });
    const gateway = createGateway({
      // bind an ephemeral port for the test
      config: {
        ...defaultConfig(),
        server: { ...defaultConfig().server, port: 0 },
      },
      registry: buildProviderRegistry({ env }),
      transport,
    });
    const { host, port } = await gateway.listen();
    try {
      const health = await fetch(`http://${host}:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok' });

      const messages = await fetch(`http://${host}:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(messages.status).toBe(200);
      expect(await messages.json()).toMatchObject({
        id: 'msg_live',
        stop_reason: 'end_turn',
      });
    } finally {
      gateway.close();
    }
  });
});

describe('errors', () => {
  it('returns a 400 invalid_request_error on a bad request', async () => {
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: '{}',
    }));
    const res = await gateway.handle({
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      body: JSON.stringify({ model: 'claude-sonnet-4' }),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.type).toBe('invalid_request_error');
  });

  it('maps a 500 upstream to an Anthropic overloaded_error (529)', async () => {
    const transport: Transport = async () => ({
      status: 500,
      headers: {},
      body: JSON.stringify({ type: 'error', error: { type: 'api_error' } }),
    });
    const { gateway, events } = harness(transport);
    const res = await gateway.handle(post('claude-sonnet-4'));
    expect(res.status).toBe(529);
    expect(JSON.parse(res.body).error.type).toBe('overloaded_error');
    expect(events[0]).toMatchObject({ success: false });
  });

  it('rejects an unregistered provider without misrouting', async () => {
    // gemini-* resolves to the google provider, which is not registered.
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: '{}',
    }));
    const res = await gateway.handle(post('gemini-2.5-pro'));
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.type).toBe('not_found_error');
  });

  it('404s an unknown route', async () => {
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: '{}',
    }));
    const res = await gateway.handle({
      method: 'GET',
      url: '/nope',
      headers: {},
      body: '',
    });
    expect(res.status).toBe(404);
  });
});
