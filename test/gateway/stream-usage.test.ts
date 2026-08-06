/**
 * Stream-end usage and the post-stream-retry invariant (Task 17, subtask 17.6).
 *
 * A streaming request's token counts arrive in the upstream's trailing frames,
 * after the status and headers are already committed. The usage event is
 * therefore emitted when the stream ends, not when it starts -- otherwise every
 * streaming request reports zero tokens.
 *
 * The same ordering pins the retry invariant: once a byte has been written to
 * the client, the response is committed and no retry or fallback may run.
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
import type { Transport } from '../../src/providers/types.js';

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

/** A streaming transport over fixed chunks, counting how often it is called. */
function streamOf(chunks: string[]) {
  const calls = { count: 0 };
  const transport: Transport = async (req, options) => {
    calls.count += 1;
    async function* body(): AsyncIterable<string> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    if (!options?.stream) {
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: chunks.join(''),
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: '',
      stream: body(),
    };
  };
  return { transport, calls };
}

/** Drain a streamed response. */
async function drain(res: GatewayResponse): Promise<string> {
  let out = '';
  for await (const chunk of res.stream!) {
    out += chunk;
  }
  return out;
}

const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4","usage":{"input_tokens":31,"output_tokens":0,"cache_read_input_tokens":9}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":47}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const CHAT_STREAM = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":23,"completion_tokens":41,"prompt_tokens_details":{"cached_tokens":5}}}\n\n',
  'data: [DONE]\n\n',
];

const RESPONSES_STREAM = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":17,"output_tokens":29,"input_tokens_details":{"cached_tokens":4}}}}\n\n',
];

describe('usage is emitted when the stream ends', () => {
  it('emits nothing until a streamed response is drained', async () => {
    const { transport } = streamOf(ANTHROPIC_STREAM);
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(
      messagesPost('claude-sonnet-4', { stream: true }),
    );
    await sinks.drain();
    // The response exists, but the upstream has reported no tokens yet.
    expect(res.stream).toBeDefined();
    expect(events).toHaveLength(0);

    await drain(res);
    await sinks.drain();
    expect(events).toHaveLength(1);
  });

  it('reports verbatim Anthropic usage from the stream frames', async () => {
    const { transport } = streamOf(ANTHROPIC_STREAM);
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(
      messagesPost('claude-sonnet-4', { stream: true }),
    );
    await drain(res);
    await sinks.drain();

    // Input and cache counts come from message_start, output from message_delta.
    expect(events[0]).toMatchObject({
      inputTokens: 31,
      outputTokens: 47,
      cacheReadTokens: 9,
      streaming: true,
    });
  });

  it('reports verbatim chat usage from the trailing usage chunk', async () => {
    const { transport } = streamOf(CHAT_STREAM);
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(chatPost('gpt-4o', { stream: true }));
    await drain(res);
    await sinks.drain();

    expect(events[0]).toMatchObject({
      inputTokens: 23,
      outputTokens: 41,
      cacheReadTokens: 5,
    });
  });

  it('reports verbatim Responses usage from the terminal snapshot', async () => {
    const { transport } = streamOf(RESPONSES_STREAM);
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(responsesPost('gpt-4o', { stream: true }));
    await drain(res);
    await sinks.drain();

    expect(events[0]).toMatchObject({ inputTokens: 17, outputTokens: 29 });
  });

  it('reports translated usage through the Anthropic-to-chat pipeline', async () => {
    const { transport } = streamOf(ANTHROPIC_STREAM);
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(
      chatPost('claude-sonnet-4', { stream: true }),
    );
    await drain(res);
    await sinks.drain();

    expect(events[0]).toMatchObject({ inputTokens: 31, outputTokens: 47 });
  });

  it('reports translated usage through the chat-to-Anthropic pipeline', async () => {
    const { transport } = streamOf(CHAT_STREAM);
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));
    await drain(res);
    await sinks.drain();

    expect(events[0]).toMatchObject({ inputTokens: 23, outputTokens: 41 });
  });

  it('reports translated usage through the chat-to-Responses pipeline', async () => {
    const { transport } = streamOf(CHAT_STREAM);
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(
      responsesPost('deepseek', { stream: true }),
    );
    await drain(res);
    await sinks.drain();

    expect(events[0]).toMatchObject({ inputTokens: 23, outputTokens: 41 });
  });

  it('still emits when the client abandons the stream early', async () => {
    const { transport } = streamOf(ANTHROPIC_STREAM);
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(
      messagesPost('claude-sonnet-4', { stream: true }),
    );

    // Read one chunk, then hang up.
    const iterator = res.stream![Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await sinks.drain();

    // The request is still accounted for, with whatever the upstream had
    // reported by then (message_start carries the input side).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ inputTokens: 31 });
  });

  it('emits exactly one event per streamed request', async () => {
    const { transport } = streamOf(ANTHROPIC_STREAM);
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(
      messagesPost('claude-sonnet-4', { stream: true }),
    );
    await drain(res);
    // Draining an exhausted iterator must not double-count.
    for await (const _chunk of res.stream!) {
      void _chunk;
    }
    await sinks.drain();
    expect(events).toHaveLength(1);
  });
});

describe('post-stream retry is forbidden', () => {
  it('does not retry when the upstream stream fails after bytes were emitted', async () => {
    let calls = 0;
    const transport: Transport = async (req, options) => {
      calls += 1;
      async function* body(): AsyncIterable<string> {
        yield ANTHROPIC_STREAM[0];
        yield ANTHROPIC_STREAM[1];
        throw new Error('upstream connection reset mid-stream');
      }
      if (!options?.stream) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{}',
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
        stream: body(),
      };
    };
    const { gateway, events, sinks } = harness(transport);
    const res = await gateway.handle(
      messagesPost('claude-sonnet-4', { stream: true }),
    );

    // The status was committed before the failure, so it stays a 200 SSE
    // response: it cannot be renegotiated into an error.
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');

    await expect(drain(res)).rejects.toThrow(/connection reset/);
    await sinks.drain();

    // No second dispatch: the failure happened after bytes reached the client.
    expect(calls).toBe(1);
    // The request is still accounted for rather than silently dropped.
    expect(events).toHaveLength(1);
  });

  it('still retries a failure that happens before any byte is emitted', async () => {
    // The connection fails before streaming starts, so the normal pre-stream
    // retry runs -- the contrast that makes the invariant meaningful rather
    // than vacuous.
    let calls = 0;
    const transport: Transport = async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
        stream: (async function* () {
          for (const chunk of ANTHROPIC_STREAM) {
            yield chunk;
          }
        })(),
      };
    };
    const { gateway } = harness(transport);
    const res = await gateway.handle(
      messagesPost('claude-sonnet-4', { stream: true }),
    );
    expect(calls).toBeGreaterThan(1);
    expect(res.status).toBe(200);
  });

  it('buffers an error response rather than streaming it', async () => {
    // The transport only streams a 2xx event-stream body, so an error status
    // always arrives fully buffered and stays classifiable.
    const transport: Transport = async () => ({
      status: 400,
      headers: { 'content-type': 'text/event-stream' },
      body: '{"error":{"type":"invalid_request_error","message":"bad"}}',
    });
    const { gateway } = harness(transport);
    const res = await gateway.handle(
      messagesPost('claude-sonnet-4', { stream: true }),
    );
    expect(res.stream).toBeUndefined();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['content-type']).toBe('application/json');
  });
});
