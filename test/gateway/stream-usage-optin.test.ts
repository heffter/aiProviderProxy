/**
 * Streaming usage opt-in for OpenAI-style upstreams (Task 23).
 *
 * Chat Completions emits its trailing, choice-less usage chunk only when the
 * request sets `stream_options.include_usage`. Without it a streamed response
 * carries no token counts, so the usage event, budget enforcement and the
 * Tokemetry export all record zero spend for streamed translated traffic.
 *
 * Caught against a real upstream: `/v1/messages` with `gpt-4o` recorded
 * in=14 out=1 non-streaming, and in=0 out=0 for the identical streaming
 * request.
 *
 * The opt-in belongs only where the gateway builds the upstream body itself.
 * The verbatim chat path forwards the client's own body, and adding a usage
 * chunk the client never requested would change a stream the client owns.
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
  ZAI_API_KEY: 'sk-zai-envkey',
  DEEPSEEK_API_KEY: 'sk-deepseek-envkey',
} as NodeJS.ProcessEnv;

/** A chat upstream stream that reports usage on the trailing chunk. */
const CHAT_STREAM = [
  'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":31,"completion_tokens":47}}\n\n',
  'data: [DONE]\n\n',
];

/** Capture the upstream body the gateway sent, and stream a chat response. */
function harness() {
  const sent: Array<Record<string, unknown>> = [];
  const events: CanonicalUsageEvent[] = [];
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onLogicalRequestFinal: (e) => {
      events.push(e);
    },
  });
  const transport: Transport = async (req, options) => {
    sent.push(JSON.parse(req.body ?? '{}') as Record<string, unknown>);
    if (!options?.stream) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 31, completion_tokens: 47 },
        }),
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: '',
      stream: (async function* () {
        for (const chunk of CHAT_STREAM) {
          yield chunk;
        }
      })(),
    };
  };
  const gateway = createGateway({
    config: defaultConfig(),
    registry: buildProviderRegistry({ env }),
    transport,
    sinks,
    outbox: new TokemetryOutbox({ database: new Database(':memory:') }),
  });
  return { gateway, sent, events, sinks };
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

/** Drain a streamed response so the pipeline completes and usage is emitted. */
async function drain(res: GatewayResponse): Promise<void> {
  if (!res.stream) return;
  for await (const chunk of res.stream) {
    void chunk;
  }
}

const messagesPost = (model: string, extra: Record<string, unknown> = {}) =>
  post(
    '/v1/messages',
    { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra },
    model,
  );

describe('translated Messages -> chat upstream', () => {
  it('requests streaming usage when the client streams', async () => {
    const { gateway, sent } = harness();
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));
    await drain(res);
    expect(sent[0].stream).toBe(true);
    expect(sent[0].stream_options).toEqual({ include_usage: true });
  });

  it('does not send the opt-in on a non-streaming request', async () => {
    const { gateway, sent } = harness();
    await gateway.handle(messagesPost('gpt-4o'));
    expect(sent[0].stream_options).toBeUndefined();
  });

  it('records the upstream token counts for a streamed request', async () => {
    // The regression: this reported in=0 out=0 because the upstream was never
    // asked to emit a usage chunk.
    const { gateway, events, sinks } = harness();
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));
    await drain(res);
    await sinks.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ inputTokens: 31, outputTokens: 47 });
  });

  it('applies to any OpenAI-compatible upstream, not just OpenAI', async () => {
    // Z.ai and the other openai-compatible providers stream through the same
    // translated path, so they had the same zero-usage bug.
    const { gateway, sent } = harness();
    const res = await gateway.handle(messagesPost('glm', { stream: true }));
    await drain(res);
    expect(sent[0].stream_options).toEqual({ include_usage: true });
  });
});

describe('translated Responses -> chat upstream', () => {
  it('requests streaming usage when the client streams', async () => {
    const { gateway, sent } = harness();
    const res = await gateway.handle(
      post('/v1/responses', { input: 'hi', stream: true }, 'deepseek'),
    );
    await drain(res);
    expect(sent[0].stream_options).toEqual({ include_usage: true });
  });

  it('does not send the opt-in on a non-streaming request', async () => {
    const { gateway, sent } = harness();
    await gateway.handle(post('/v1/responses', { input: 'hi' }, 'deepseek'));
    expect(sent[0].stream_options).toBeUndefined();
  });
});

describe('verbatim chat pass-through', () => {
  it('leaves the client body alone', async () => {
    // Deliberate: the client owns this stream. Injecting the opt-in would add
    // a usage chunk it never asked for.
    const { gateway, sent } = harness();
    const res = await gateway.handle(
      post(
        '/v1/chat/completions',
        { messages: [{ role: 'user', content: 'hi' }], stream: true },
        'gpt-4o',
      ),
    );
    await drain(res);
    expect(sent[0].stream_options).toBeUndefined();
  });

  it('forwards the opt-in when the client asked for it', async () => {
    const { gateway, sent } = harness();
    const res = await gateway.handle(
      post(
        '/v1/chat/completions',
        {
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          stream_options: { include_usage: true },
        },
        'gpt-4o',
      ),
    );
    await drain(res);
    expect(sent[0].stream_options).toEqual({ include_usage: true });
  });
});
