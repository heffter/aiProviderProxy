/**
 * Content capture for streamed responses (Task 21).
 *
 * Task 17 made streaming incremental, which buffers nothing -- so
 * `parsedResponse.body` is empty for a streamed request and the history log
 * recorded an empty response. Content logging is ON by default and most Claude
 * Code traffic streams, so that silently emptied the response side of
 * history.jsonl for the common case.
 *
 * The response is now rebuilt from the deltas as they pass by and recorded when
 * the stream ends. These tests pin the reconstruction, its timing (content must
 * land before the sink drains the buffer), the size cap, and the disclosure
 * contract: content logging OFF still records nothing, and streamed content
 * never reaches the canonical usage event.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createGateway,
  type GatewayRequest,
  type GatewayResponse,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { ContentBuffer } from '../../src/gateway/content-buffer.js';
import { HistorySink } from '../../src/ops/trackers/history-sink.js';
import { defaultConfig } from '../../src/config/index.js';
import { EventSinkRegistry } from '../../src/lifecycle/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { Transport } from '../../src/providers/types.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-envkey',
  OPENAI_API_KEY: 'sk-openai-envkey',
} as NodeJS.ProcessEnv;

const REPLY_MARKER = 'REPLY_MARKER_9b2c40';

/** An Anthropic upstream stream whose text spells out the reply marker. */
const anthropicStream = (text = REPLY_MARKER) => [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })}\n\n`,
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

/** A transport that streams the given chunks when asked to. */
function streamOf(chunks: string[]): Transport {
  return async (req, options) => {
    async function* body(): AsyncIterable<string> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    if (!options?.stream) {
      return {
        status: 200,
        headers: {
          'request-id': 'req_ant',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: REPLY_MARKER }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      };
    }
    return {
      status: 200,
      headers: {
        'request-id': 'req_ant',
        'content-type': 'text/event-stream',
      },
      body: '',
      stream: body(),
    };
  };
}

function harness(transport: Transport, contentLogEnabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'aipp-stream-content-'));
  const config = defaultConfig();
  config.contentLog.enabled = contentLogEnabled;
  const events: CanonicalUsageEvent[] = [];
  const contentBuffer = new ContentBuffer();
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onLogicalRequestFinal: (e) => {
      events.push(e);
    },
  });
  sinks.register(
    new HistorySink({
      dir,
      contentLogEnabled,
      getContent: (event) => contentBuffer.take(event.logicalRequestId),
    }),
  );
  const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
  const gateway = createGateway({
    config,
    registry: buildProviderRegistry({ env }),
    transport,
    sinks,
    outbox,
    contentBuffer,
    dataDir: dir,
  });
  return { gateway, events, sinks, contentBuffer, dir };
}

function messagesPost(extra: Record<string, unknown> = {}): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    }),
  };
}

/** Drain a streamed response. */
async function drain(res: GatewayResponse): Promise<void> {
  for await (const chunk of res.stream!) {
    void chunk;
  }
}

/** The `content` block of the single history entry, if one was written. */
function readContent(dir: string): {
  request?: unknown;
  response?: unknown;
} {
  const raw = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim();
  const entry = JSON.parse(raw) as Record<string, unknown>;
  return (entry.content ?? {}) as { request?: unknown; response?: unknown };
}

describe('streamed response content', () => {
  it('records the reconstructed response, not an empty body', async () => {
    const { gateway, sinks, dir } = harness(streamOf(anthropicStream()));
    try {
      const res = await gateway.handle(messagesPost({ stream: true }));
      await drain(res);
      await sinks.drain();

      const content = readContent(dir);
      // The regression this fixes: response content was empty for streams.
      expect(JSON.stringify(content.response)).toContain(REPLY_MARKER);
      expect(content.response).toMatchObject({ streamed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures at stream end, not at dispatch', async () => {
    const { gateway, contentBuffer, dir } = harness(
      streamOf(anthropicStream()),
    );
    try {
      const res = await gateway.handle(messagesPost({ stream: true }));
      // The response object exists, but not one delta has been read, so there
      // is nothing to record and no history entry yet.
      expect(contentBuffer.size).toBe(0);
      expect(existsSync(join(dir, 'history.jsonl'))).toBe(false);

      await drain(res);
      // Draining ends the stream, which records the content and then emits the
      // usage event; the sink takes the content read-and-clear as part of that,
      // so the buffer is empty again and the entry is on disk.
      expect(contentBuffer.size).toBe(0);
      expect(JSON.stringify(readContent(dir).response)).toContain(REPLY_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures tool calls made over a stream', async () => {
    const toolStream = [
      anthropicStream()[0],
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      anthropicStream()[4],
      anthropicStream()[5],
    ];
    const { gateway, sinks, dir } = harness(streamOf(toolStream));
    try {
      const res = await gateway.handle(messagesPost({ stream: true }));
      await drain(res);
      await sinks.drain();

      const content = readContent(dir);
      // Argument fragments are reassembled into the recorded call.
      expect(content.response).toMatchObject({
        streamed: true,
        tool_calls: [{ name: 'get_weather', arguments: '{"city":"SF"}' }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks an oversized response truncated instead of growing unbounded', async () => {
    // Well past the 128 KiB cap.
    const huge = 'x'.repeat(200 * 1024);
    const { gateway, sinks, dir } = harness(streamOf(anthropicStream(huge)));
    try {
      const res = await gateway.handle(messagesPost({ stream: true }));
      await drain(res);
      await sinks.drain();

      const response = readContent(dir).response as
        { text?: string; truncated?: boolean; omitted?: string } | undefined;
      // Either the accumulator capped it, or the content buffer's own size
      // limit replaced it with an omission marker. Both are bounded; what must
      // not happen is storing the whole 200 KiB verbatim.
      const stored = JSON.stringify(response ?? {});
      expect(stored.length).toBeLessThan(200 * 1024);
      if (response?.text !== undefined) {
        expect(response.truncated).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records what arrived when the client disconnects mid-stream', async () => {
    const { gateway, sinks, dir } = harness(streamOf(anthropicStream()));
    try {
      const res = await gateway.handle(messagesPost({ stream: true }));
      const iterator = res.stream![Symbol.asyncIterator]();
      // Read far enough to see the text delta, then hang up.
      for (let i = 0; i < 4; i += 1) {
        await iterator.next();
      }
      await iterator.return?.();
      await sinks.drain();

      expect(JSON.stringify(readContent(dir).response)).toContain(REPLY_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still records the real body for a non-streaming request', async () => {
    const { gateway, sinks, dir } = harness(streamOf(anthropicStream()));
    try {
      const res = await gateway.handle(messagesPost());
      expect(res.stream).toBeUndefined();
      await sinks.drain();

      const content = readContent(dir);
      // The non-streaming path is untouched: the parsed message, not a
      // reconstruction.
      expect(JSON.stringify(content.response)).toContain(REPLY_MARKER);
      expect(content.response).not.toMatchObject({ streamed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records no content for a stream when content logging is OFF', async () => {
    const { gateway, sinks, dir } = harness(streamOf(anthropicStream()), false);
    try {
      const res = await gateway.handle(messagesPost({ stream: true }));
      await drain(res);
      await sinks.drain();

      const content = readContent(dir);
      expect(content.response).toBeUndefined();
      expect(content.request).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps streamed content out of the canonical usage event', async () => {
    const { gateway, events, sinks, dir } = harness(
      streamOf(anthropicStream()),
    );
    try {
      const res = await gateway.handle(messagesPost({ stream: true }));
      await drain(res);
      await sinks.drain();

      expect(events).toHaveLength(1);
      // The disclosure contract: content lives only in the local history log.
      expect(JSON.stringify(events[0])).not.toContain(REPLY_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
