/**
 * Incremental translated streaming (Task 17, subtasks 17.4 and 17.5).
 *
 * Three directions are covered end to end through the gateway:
 *   Anthropic upstream -> Chat Completions client   (17.4)
 *   Chat upstream      -> Responses client          (17.4)
 *   Chat upstream      -> Anthropic Messages client (17.5)
 *
 * The assertions target incrementality, not just final bytes: the mock upstream
 * blocks until the gateway has surfaced the previous client event, so a path
 * that reconstructs from a completed message would deadlock and fail by timeout.
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

/** A transport that streams fixed chunks, optionally paced by a gate. */
function streamOf(
  chunks: string[],
  gate?: { at: number; wait: Promise<void> },
) {
  const transport: Transport = async (req, options) => {
    async function* body(): AsyncIterable<string> {
      for (let i = 0; i < chunks.length; i += 1) {
        if (gate && i === gate.at) {
          await gate.wait;
        }
        yield chunks[i];
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
  return transport;
}

/** Collect a streamed response into one transcript. */
async function transcript(res: GatewayResponse): Promise<string> {
  let out = '';
  for await (const chunk of res.stream!) {
    out += chunk;
  }
  return out;
}

/** Parse a chat SSE transcript into its decoded chunk payloads. */
function chatChunks(sse: string): Array<Record<string, unknown>> {
  return sse
    .split('\n\n')
    .map((b) => b.replace(/^data: /, '').trim())
    .filter((b) => b.length > 0 && b !== '[DONE]')
    .map((b) => JSON.parse(b) as Record<string, unknown>);
}

/** Parse an SSE transcript into ordered {event, data} records. */
function sseRecords(sse: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of sse.split('\n\n')) {
    if (block.trim() === '') continue;
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) data = line.slice('data: '.length);
    }
    out.push({ event, data: data === '[DONE]' ? data : JSON.parse(data) });
  }
  return out;
}

/** An Anthropic upstream stream: text, then a tool call, then usage. */
const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4","usage":{"input_tokens":12,"output_tokens":0,"cache_read_input_tokens":7}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

/** A chat upstream stream: role, text deltas, finish, usage trailer, DONE. */
const CHAT_STREAM = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":7}}}\n\n',
  'data: [DONE]\n\n',
];

const chatPost = (model: string, extra: Record<string, unknown> = {}) =>
  post(
    '/v1/chat/completions',
    { messages: [{ role: 'user', content: 'hi' }], ...extra },
    model,
  );

const messagesPost = (model: string, extra: Record<string, unknown> = {}) =>
  post(
    '/v1/messages',
    { max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }], ...extra },
    model,
  );

const responsesPost = (model: string, extra: Record<string, unknown> = {}) =>
  post('/v1/responses', { input: 'hello', ...extra }, model);

describe('Anthropic upstream -> Chat client', () => {
  it('translates deltas into chat chunks incrementally', async () => {
    const { gateway } = harness(streamOf(ANTHROPIC_STREAM));
    const res = await gateway.handle(
      chatPost('claude-sonnet-4', { stream: true }),
    );

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.stream).toBeDefined();
    const sse = await transcript(res);
    const chunks = chatChunks(sse);

    // Opens with a role chunk, then one chunk per upstream text delta -- the
    // deltas are not coalesced into a single message.
    expect(chunks[0]).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ delta: { role: 'assistant' } }],
    });
    const texts = chunks
      .map((c) => {
        const choices = c.choices as Array<{ delta?: { content?: string } }>;
        return choices?.[0]?.delta?.content;
      })
      .filter((t): t is string => typeof t === 'string');
    expect(texts).toEqual(['Hel', 'lo']);

    // The tool call keeps its argument fragmentation.
    const toolArgs = chunks
      .map((c) => {
        const choices = c.choices as Array<{
          delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> };
        }>;
        return choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments;
      })
      .filter((a): a is string => typeof a === 'string' && a.length > 0);
    expect(toolArgs).toEqual(['{"city":', '"SF"}']);

    expect(sse.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('maps the stop reason and carries usage on the terminal chunk', async () => {
    const { gateway } = harness(streamOf(ANTHROPIC_STREAM));
    const res = await gateway.handle(
      chatPost('claude-sonnet-4', { stream: true }),
    );
    const chunks = chatChunks(await transcript(res));

    const finish = chunks.find((c) => {
      const choices = c.choices as Array<{ finish_reason?: string | null }>;
      return choices?.[0]?.finish_reason != null;
    });
    // Anthropic tool_use maps to the chat finish reason tool_calls.
    expect(finish).toMatchObject({
      choices: [{ finish_reason: 'tool_calls' }],
    });

    // Usage arrives on a trailing choice-less chunk, merged from message_start
    // (input, cache) and message_delta (output).
    const usageChunk = chunks.find((c) => c.usage !== undefined);
    expect(usageChunk?.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 25,
      prompt_tokens_details: { cached_tokens: 7 },
    });
  });

  it('emits each chunk before the upstream produces the next', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Block the upstream just before its second text delta.
    const { gateway } = harness(streamOf(ANTHROPIC_STREAM, { at: 3, wait }));
    const res = await gateway.handle(
      chatPost('claude-sonnet-4', { stream: true }),
    );

    const iterator = res.stream![Symbol.asyncIterator]();
    const seen: string[] = [];
    // Drain until the first text delta surfaces; this must happen while the
    // upstream is still blocked.
    for (;;) {
      const next = await iterator.next();
      seen.push(next.value as string);
      if (seen.join('').includes('"content":"Hel"')) {
        break;
      }
    }
    expect(seen.join('')).not.toContain('"content":"lo"');
    release();
    await iterator.return?.();
  });

  it('drops thinking blocks, which chat cannot represent', async () => {
    const withThinking = [
      ANTHROPIC_STREAM[0],
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"do-not-leak"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"visible"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const { gateway } = harness(streamOf(withThinking));
    const res = await gateway.handle(
      chatPost('claude-sonnet-4', { stream: true }),
    );
    const sse = await transcript(res);
    expect(sse).not.toContain('do-not-leak');
    expect(sse).toContain('"content":"visible"');
  });

  it('terminates a truncated upstream stream cleanly', async () => {
    // Upstream dies after one delta: no message_delta, no message_stop.
    const { gateway } = harness(streamOf(ANTHROPIC_STREAM.slice(0, 4)));
    const res = await gateway.handle(
      chatPost('claude-sonnet-4', { stream: true }),
    );
    const sse = await transcript(res);
    expect(sse).toContain('"content":"Hel"');
    // The client still sees a well-formed, terminated stream.
    expect(sse).toContain('"finish_reason"');
    expect(sse.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('Chat upstream -> Responses client', () => {
  it('translates chat chunks into Responses events incrementally', async () => {
    const { gateway } = harness(streamOf(CHAT_STREAM));
    const res = await gateway.handle(
      responsesPost('deepseek', {
        stream: true,
      }),
    );

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.stream).toBeDefined();
    const records = sseRecords(await transcript(res));
    const names = records.map((r) => r.event);

    expect(names[0]).toBe('response.created');
    expect(names).toContain('response.output_item.added');
    expect(names[names.length - 1]).toBe('response.completed');

    // One delta event per upstream delta: nothing coalesced.
    const deltas = records
      .filter((r) => r.event === 'response.output_text.delta')
      .map((r) => (r.data as { delta: string }).delta);
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('carries usage from the upstream trailer onto the terminal event', async () => {
    const { gateway } = harness(streamOf(CHAT_STREAM));
    const res = await gateway.handle(
      responsesPost('deepseek', {
        stream: true,
      }),
    );
    const records = sseRecords(await transcript(res));
    const done = records[records.length - 1].data as {
      response: { usage: Record<string, unknown>; status: string };
    };
    expect(done.response.status).toBe('completed');
    expect(done.response.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 5,
    });
  });

  it('emits each event before the upstream produces the next', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Block just before the second content delta.
    const { gateway } = harness(streamOf(CHAT_STREAM, { at: 2, wait }));
    const res = await gateway.handle(
      responsesPost('deepseek', {
        stream: true,
      }),
    );

    const iterator = res.stream![Symbol.asyncIterator]();
    const seen: string[] = [];
    for (;;) {
      const next = await iterator.next();
      seen.push(next.value as string);
      if (seen.join('').includes('"delta":"Hel"')) {
        break;
      }
    }
    expect(seen.join('')).not.toContain('"delta":"lo"');
    release();
    await iterator.return?.();
  });

  it('reports a truncated upstream stream as incomplete', async () => {
    // No finish_reason, no [DONE].
    const { gateway } = harness(streamOf(CHAT_STREAM.slice(0, 3)));
    const res = await gateway.handle(
      responsesPost('deepseek', {
        stream: true,
      }),
    );
    const records = sseRecords(await transcript(res));
    const last = records[records.length - 1];
    expect(last.event).toBe('response.incomplete');
    // Any open output item was closed before the terminal event.
    expect(records.map((r) => r.event)).toContain('response.output_item.done');
  });

  it('translates a tool call into a function_call output item', async () => {
    const toolStream = [
      CHAT_STREAM[0],
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"SF\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const { gateway } = harness(streamOf(toolStream));
    const res = await gateway.handle(
      responsesPost('deepseek', {
        stream: true,
      }),
    );
    const sse = await transcript(res);
    expect(sse).toContain('"name":"get_weather"');
    expect(sse).toContain('function_call_arguments.delta');
    expect(sse).toContain('response.completed');
  });
});

describe('Chat upstream -> Anthropic Messages client (17.5)', () => {
  it('translates chat chunks into Anthropic events incrementally', async () => {
    const { gateway } = harness(streamOf(CHAT_STREAM));
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.stream).toBeDefined();
    const records = sseRecords(await transcript(res));
    const names = records.map((r) => r.event);

    // A spec-valid Anthropic transcript with explicit block lifecycle.
    expect(names).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    // One delta per upstream delta: nothing coalesced into a single block.
    const texts = records
      .filter((r) => r.event === 'content_block_delta')
      .map((r) => (r.data as { delta: { text: string } }).delta.text);
    expect(texts).toEqual(['Hel', 'lo']);
  });

  it('maps the finish reason and carries usage on message_delta', async () => {
    const { gateway } = harness(streamOf(CHAT_STREAM));
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));
    const records = sseRecords(await transcript(res));

    const delta = records.find((r) => r.event === 'message_delta');
    expect(delta?.data).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5, input_tokens: 12 },
    });
  });

  it('maps a length finish to max_tokens', async () => {
    const truncated = [
      CHAT_STREAM[0],
      CHAT_STREAM[1],
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const { gateway } = harness(streamOf(truncated));
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));
    const records = sseRecords(await transcript(res));
    expect(
      records.find((r) => r.event === 'message_delta')?.data,
    ).toMatchObject({ delta: { stop_reason: 'max_tokens' } });
  });

  it('emits each event before the upstream produces the next', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { gateway } = harness(streamOf(CHAT_STREAM, { at: 2, wait }));
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));

    const iterator = res.stream![Symbol.asyncIterator]();
    const seen: string[] = [];
    for (;;) {
      const next = await iterator.next();
      seen.push(next.value as string);
      if (seen.join('').includes('"text":"Hel"')) {
        break;
      }
    }
    expect(seen.join('')).not.toContain('"text":"lo"');
    release();
    await iterator.return?.();
  });

  it('maps reasoning deltas onto a thinking block', async () => {
    const withReasoning = [
      CHAT_STREAM[0],
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"pondering"},"finish_reason":null}]}\n\n',
      CHAT_STREAM[1],
      CHAT_STREAM[3],
      'data: [DONE]\n\n',
    ];
    const { gateway } = harness(streamOf(withReasoning));
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));
    const records = sseRecords(await transcript(res));

    const starts = records
      .filter((r) => r.event === 'content_block_start')
      .map(
        (r) =>
          (r.data as { content_block: { type: string } }).content_block.type,
      );
    // Reasoning opens a thinking block, then the text switches to a new block.
    expect(starts).toEqual(['thinking', 'text']);
    expect(
      records.map((r) => r.event).filter((n) => n === 'content_block_stop'),
    ).toHaveLength(2);
  });

  it('translates a tool call into a tool_use block', async () => {
    const toolStream = [
      CHAT_STREAM[0],
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const { gateway } = harness(streamOf(toolStream));
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));
    const records = sseRecords(await transcript(res));

    expect(records[1].data).toMatchObject({
      content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' },
    });
    // Argument fragmentation is preserved rather than reassembled.
    const partials = records
      .filter((r) => r.event === 'content_block_delta')
      .map(
        (r) =>
          (r.data as { delta: { partial_json: string } }).delta.partial_json,
      );
    expect(partials).toEqual(['{"city":', '"SF"}']);
    expect(
      records.find((r) => r.event === 'message_delta')?.data,
    ).toMatchObject({ delta: { stop_reason: 'tool_use' } });
  });

  it('terminates a truncated upstream stream cleanly', async () => {
    // Upstream dies mid-generation: no finish_reason, no [DONE].
    const { gateway } = harness(streamOf(CHAT_STREAM.slice(0, 2)));
    const res = await gateway.handle(messagesPost('gpt-4o', { stream: true }));
    const records = sseRecords(await transcript(res));
    const names = records.map((r) => r.event);
    // The open block is closed and the message terminated, so an Anthropic SSE
    // client sees a well-formed stream rather than a dangling one.
    expect(names[names.length - 2]).toBe('message_delta');
    expect(names[names.length - 1]).toBe('message_stop');
    expect(names).toContain('content_block_stop');
  });
});
