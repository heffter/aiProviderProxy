/**
 * Integration tests for the OpenAI Responses surface (epic AIPP-7).
 *
 * Drives the /v1/responses pipeline against mock transports: the native OpenAI
 * passthrough, the translated chat-upstream path (object + streaming), hosted-
 * tool policy, and tool-router enforcement, asserting content-free usage events
 * reach the sinks and outbox.
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
import type { Config } from '../../src/config/index.js';
import { ToolAuthorizer } from '../../src/tools/index.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-envkey',
  OPENAI_API_KEY: 'sk-openai-envkey',
  DEEPSEEK_API_KEY: 'sk-deepseek-envkey',
} as NodeJS.ProcessEnv;

function post(
  model: string,
  extra: Record<string, unknown> = {},
): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/responses',
    headers: {
      'content-type': 'application/json',
      'x-claude-code-session-id': 'sess-1',
    },
    body: JSON.stringify({ model, input: 'hello', ...extra }),
  };
}

function harness(
  transport: Transport,
  opts: { toolAuthorizer?: ToolAuthorizer; config?: Config } = {},
) {
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
    config: opts.config ?? defaultConfig(),
    registry: buildProviderRegistry({ env }),
    transport,
    sinks,
    outbox,
    toolAuthorizer: opts.toolAuthorizer,
  });
  return { gateway, events, sinks, outbox };
}

describe('native OpenAI Responses passthrough', () => {
  it('forwards to /responses and returns the body verbatim', async () => {
    const responsesObj = {
      id: 'resp_123',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hi', annotations: [] }],
        },
      ],
      usage: { input_tokens: 9, output_tokens: 3 },
    };
    const transport: Transport = async (req) => {
      expect(req.url).toBe('https://api.openai.com/v1/responses');
      return {
        status: 200,
        headers: { 'x-request-id': 'req_oai' },
        body: JSON.stringify(responsesObj),
      };
    };
    const { gateway, events, sinks, outbox } = harness(transport);
    const res = await gateway.handle(post('gpt-4o'));
    await sinks.drain();

    expect(res.status).toBe(200);
    expect(res.headers['request-id']).toBe('req_oai');
    expect(JSON.parse(res.body)).toEqual(responsesObj); // verbatim
    expect(events[0]).toMatchObject({
      provider: 'openai',
      eventId: 'req_oai',
      inputTokens: 9,
      outputTokens: 3,
    });
    expect(outbox.counts().pending).toBe(1);
  });
});

describe('translated chat-upstream path', () => {
  const chatResponse = {
    id: 'chatcmpl-1',
    choices: [{ finish_reason: 'stop', message: { content: 'translated hi' } }],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  };

  it('translates to /chat/completions and reconstructs a Responses object', async () => {
    let forwarded: unknown;
    const transport: Transport = async (req) => {
      expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions');
      forwarded = JSON.parse(req.body ?? '{}');
      return {
        status: 200,
        headers: { 'x-request-id': 'req_ds' },
        body: JSON.stringify(chatResponse),
      };
    };
    const { gateway, events } = harness(transport);
    const res = await gateway.handle(post('deepseek'));

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.model).toBe('deepseek-chat');
    expect(body.output[0].content[0]).toEqual({
      type: 'output_text',
      text: 'translated hi',
      annotations: [],
    });
    expect(body.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
    });
    expect((forwarded as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'hello' },
    ]);
    expect(events[0]).toMatchObject({
      provider: 'deepseek',
      eventId: 'req_ds',
    });
  });

  it('serves a streaming request as a Responses SSE transcript', async () => {
    const transport: Transport = async () => ({
      status: 200,
      headers: { 'x-request-id': 'req_ds2' },
      body: JSON.stringify(chatResponse),
    });
    const { gateway } = harness(transport);
    const res = await gateway.handle(post('deepseek', { stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('event: response.created');
    expect(res.body).toContain('event: response.output_text.delta');
    expect(res.body).toContain('event: response.completed');
    expect(res.body).toContain('"output_text":"translated hi"');
  });
});

describe('hosted-tool policy', () => {
  it('rejects hosted tools on a chat upstream with a capability error', async () => {
    const { gateway } = harness(async () => {
      throw new Error('transport must not be called');
    });
    const res = await gateway.handle(
      post('deepseek', { tools: [{ type: 'web_search' }] }),
    );
    expect(res.status).toBe(400);
    const err = JSON.parse(res.body).error;
    expect(err.type).toBe('invalid_request_error');
    expect(err.code).toBe('hosted_tool_unsupported');
  });

  it('passes hosted tools through to OpenAI when configured as allowed', async () => {
    let forwarded: unknown;
    const transport: Transport = async (req) => {
      expect(req.url).toBe('https://api.openai.com/v1/responses');
      forwarded = JSON.parse(req.body ?? '{}');
      return {
        status: 200,
        headers: { 'x-request-id': 'req_h' },
        body: JSON.stringify({ id: 'resp_h', object: 'response' }),
      };
    };
    const base = defaultConfig();
    const config: Config = {
      ...base,
      protocols: {
        ...base.protocols,
        openaiResponses: { enabled: true, allowedHostedTools: ['web_search'] },
      },
    };
    const { gateway } = harness(transport, { config });
    const res = await gateway.handle(
      post('gpt-4o', { tools: [{ type: 'web_search' }] }),
    );
    expect(res.status).toBe(200);
    expect((forwarded as { tools: Array<{ type: string }> }).tools).toEqual([
      { type: 'web_search' },
    ]);
  });
});

describe('tool-router authorization', () => {
  function toolPost(names: string[], stream = false): GatewayRequest {
    return post('deepseek', {
      stream,
      tools: names.map((name) => ({ type: 'function', name })),
    });
  }

  it('strips denied function tools from the translated chat body', async () => {
    let forwarded: unknown;
    const transport: Transport = async (req) => {
      forwarded = JSON.parse(req.body ?? '{}');
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          id: 'c',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      };
    };
    const authorizer = new ToolAuthorizer({ enabled: true });
    const { gateway } = harness(transport, { toolAuthorizer: authorizer });
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
    const { gateway, events } = harness(
      async () => {
        throw new Error('transport must not be called');
      },
      { toolAuthorizer: authorizer },
    );
    const req = toolPost(['web_search']);
    req.headers['x-task-type'] = 'code';
    const res = await gateway.handle(req);

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.type).toBe('permission_error');
    expect(events[0]).toMatchObject({
      success: false,
      outcome: 'policy_rejected',
    });
  });
});

describe('responses errors', () => {
  it('returns a 400 on a malformed request', async () => {
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: '{}',
    }));
    const res = await gateway.handle({
      method: 'POST',
      url: '/v1/responses',
      headers: {},
      body: JSON.stringify({ model: 'gpt-4o' }), // no input
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.type).toBe('invalid_request_error');
  });

  it('rejects an unknown model', async () => {
    const { gateway } = harness(async () => ({
      status: 200,
      headers: {},
      body: '{}',
    }));
    const res = await gateway.handle(post('no-such-model-xyz'));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.param).toBe('model');
  });

  it('maps a 500 upstream to a server_error', async () => {
    const transport: Transport = async () => ({
      status: 500,
      headers: {},
      body: JSON.stringify({ error: { type: 'server_error' } }),
    });
    const { gateway, events } = harness(transport);
    const res = await gateway.handle(post('deepseek'));
    expect(res.status).toBeGreaterThanOrEqual(429);
    expect(events[0]).toMatchObject({ success: false });
  });
});
