/**
 * Verbatim SSE pass-through across the three client surfaces (Task 17, 17.3).
 *
 * When the upstream already speaks the client's protocol, its SSE bytes are the
 * response: they are forwarded chunk by chunk, unaltered, with no intermediate
 * buffering. These tests assert both the bytes and the incrementality -- the
 * mock upstream blocks until the gateway has surfaced the previous chunk, so a
 * buffered implementation fails by timeout rather than by assertion.
 *
 * Also covers the Messages-surface streaming bug this subtask fixed: a
 * `stream: true` request used to be answered with a JSON body regardless of
 * upstream, which no Anthropic SSE client can consume.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  createGateway,
  type GatewayRequest,
  type GatewayResponse,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import { EventSinkRegistry } from '../../src/lifecycle/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { Transport, TransportOptions } from '../../src/providers/types.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-envkey',
  OPENAI_API_KEY: 'sk-openai-envkey',
  DEEPSEEK_API_KEY: 'sk-deepseek-envkey',
} as NodeJS.ProcessEnv;

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
  return { gateway, events, sinks };
}

function post(
  url: string,
  body: Record<string, unknown>,
  model: string,
): GatewayRequest {
  return {
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-claude-code-session-id': 'sess-1',
    },
    body: JSON.stringify({ model, ...body }),
  };
}

const messagesPost = (model: string, extra: Record<string, unknown> = {}) =>
  post(
    '/v1/messages',
    { max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }], ...extra },
    model,
  );

const chatPost = (model: string, extra: Record<string, unknown> = {}) =>
  post(
    '/v1/chat/completions',
    { messages: [{ role: 'user', content: 'hi' }], ...extra },
    model,
  );

const responsesPost = (model: string, extra: Record<string, unknown> = {}) =>
  post('/v1/responses', { input: 'hello', ...extra }, model);

/**
 * A transport that streams the given chunks, recording whether the gateway
 * actually asked for a stream. `gate` (when provided) is awaited before the
 * second chunk, so the test can prove the first one already reached the caller.
 */
function streamingTransport(
  chunks: string[],
  opts: { gate?: Promise<void>; headers?: Record<string, string> } = {},
) {
  const seen: { stream?: boolean; body?: unknown } = {};
  const transport: Transport = async (req, options?: TransportOptions) => {
    seen.stream = options?.stream;
    seen.body = JSON.parse(req.body ?? '{}');
    async function* body(): AsyncIterable<string> {
      for (let i = 0; i < chunks.length; i += 1) {
        if (i === 1 && opts.gate) {
          await opts.gate;
        }
        yield chunks[i];
      }
    }
    if (!options?.stream) {
      // Mirrors the real transport: no stream requested, so buffer the body.
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream', ...opts.headers },
        body: chunks.join(''),
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream', ...opts.headers },
      body: '',
      stream: body(),
    };
  };
  return { transport, seen };
}

/** Drain a streamed gateway response into its chunks. */
async function drain(res: GatewayResponse): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of res.stream!) {
    out.push(chunk);
  }
  return out;
}

describe('Anthropic Messages surface', () => {
  const chunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  it('pipes a verbatim Anthropic stream through unaltered', async () => {
    const { transport, seen } = streamingTransport(chunks);
    const { gateway } = harness(transport);
    const res = await gateway.handle(
      messagesPost('claude-sonnet-4', {
        stream: true,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    // The gateway asked the transport for a stream, and forwarded one.
    expect(seen.stream).toBe(true);
    expect(res.stream).toBeDefined();
    expect(res.body).toBe('');
    // Byte-identical pass-through: nothing re-encoded, nothing coalesced.
    expect(await drain(res)).toEqual(chunks);
  });

  it('surfaces each upstream chunk before the next is produced', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { transport } = streamingTransport(chunks, { gate });
    const { gateway } = harness(transport);
    const res = await gateway.handle(
      messagesPost('claude-sonnet-4', {
        stream: true,
      }),
    );

    const iterator = res.stream![Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toBe(chunks[0]);
    // Only now let the upstream produce chunk two: delivery was incremental.
    release();
    expect((await iterator.next()).value).toBe(chunks[1]);
    await iterator.return?.();
  });

  it('does not stream a non-streaming request', async () => {
    const { transport, seen } = streamingTransport(chunks);
    const { gateway } = harness(transport);
    const res = await gateway.handle(messagesPost('claude-sonnet-4'));
    expect(seen.stream).toBe(false);
    expect(res.stream).toBeUndefined();
    expect(res.headers['content-type']).toBe('application/json');
  });

  it('answers a translated streaming request with Anthropic SSE, not JSON', async () => {
    // Regression: this path used to JSON.stringify the upstream body (or its
    // raw SSE text) and return content-type application/json.
    const completion = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello from GPT.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    // The upstream answered with a plain buffered body rather than an event
    // stream, so the transcript is synthesized from the completed message --
    // the fallback behind the incremental path of subtask 17.5.
    const transport: Transport = async () => ({
      status: 200,
      headers: { 'x-request-id': 'req_oai' },
      body: JSON.stringify(completion),
    });
    const { gateway } = harness(transport);
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    // A spec-valid Anthropic transcript, in order.
    expect(res.body).toContain('event: message_start');
    expect(res.body).toContain('event: content_block_start');
    expect(res.body).toContain('"text":"Hello from GPT."');
    expect(res.body).toContain('event: message_delta');
    expect(res.body.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(
      true,
    );
    expect(res.body).not.toContain('chat.completion');
  });
});

describe('OpenAI Chat surface', () => {
  const chunks = [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  it('pipes a verbatim chat stream through unaltered', async () => {
    const { transport, seen } = streamingTransport(chunks);
    const { gateway } = harness(transport);
    const res = await gateway.handle(chatPost('gpt-4o', { stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(seen.stream).toBe(true);
    expect(await drain(res)).toEqual(chunks);
  });

  it('still synthesizes a transcript for a translated upstream', async () => {
    const anthropicResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from Claude.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 4 },
    };
    // The gateway asks for a stream, but this upstream answered with a plain
    // buffered body (not an event stream). The transcript is then synthesized
    // from the completed message -- the fallback the incremental path needs.
    const transport: Transport = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(anthropicResponse),
    });
    const { gateway } = harness(transport);
    const res = await gateway.handle(
      chatPost('claude-sonnet-4', { stream: true }),
    );
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.stream).toBeUndefined();
    expect(res.body).toContain('"content":"Hello from Claude."');
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('OpenAI Responses surface', () => {
  const chunks = [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed"}\n\n',
  ];

  it('pipes a native Responses stream through unaltered', async () => {
    const { transport, seen } = streamingTransport(chunks);
    const { gateway } = harness(transport);
    const res = await gateway.handle(responsesPost('gpt-4o', { stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(seen.stream).toBe(true);
    expect(await drain(res)).toEqual(chunks);
  });

  it('still synthesizes a transcript for a chat upstream', async () => {
    const chatResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'translated hi' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    };
    // As above: the upstream answered with a buffered body rather than an event
    // stream, so the transcript is synthesized from the completed result.
    const transport: Transport = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(chatResponse),
    });
    const { gateway } = harness(transport);
    const res = await gateway.handle(
      responsesPost('deepseek', { stream: true }),
    );
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.stream).toBeUndefined();
    expect(res.body).toContain('event: response.created');
    expect(res.body).toContain('"output_text":"translated hi"');
  });
});
