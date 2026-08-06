/**
 * Streaming HTTP transport (Task 17, subtask 17.1).
 *
 * The transport streams a body only when the caller asked for it AND the
 * upstream answered with a successful event-stream response. Every other case
 * -- notably every error status -- stays fully buffered, because pre-stream
 * retry and error classification both read {@link TransportResponse.body}.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { httpTransport } from '../../src/gateway/transport.js';

const REQUEST = {
  url: 'https://upstream.test/v1/messages',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
};

/** A byte stream over the given raw chunks. */
function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** A byte stream over the UTF-8 encoding of each text chunk. */
function textStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return byteStream(chunks.map((chunk) => encoder.encode(chunk)));
}

/** Install a fetch stub returning the given response. */
function stubFetch(response: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
}

/** Drain an async iterable into an array. */
async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) {
    out.push(chunk);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpTransport', () => {
  it('buffers the body when streaming was not requested', async () => {
    stubFetch(
      new Response('data: one\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const response = await httpTransport(REQUEST);
    expect(response.status).toBe(200);
    expect(response.body).toBe('data: one\n\n');
    expect(response.stream).toBeUndefined();
  });

  it('streams a successful event-stream body chunk by chunk', async () => {
    stubFetch(
      new Response(textStream('data: one\n\n', 'data: two\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const response = await httpTransport(REQUEST, { stream: true });
    expect(response.status).toBe(200);
    // The buffered body is empty: the stream is the only way to read it.
    expect(response.body).toBe('');
    expect(response.stream).toBeDefined();
    expect(await collect(response.stream!)).toEqual([
      'data: one\n\n',
      'data: two\n\n',
    ]);
  });

  it('reassembles a multi-byte character split across two chunks', async () => {
    // "é" is 0xC3 0xA9; the network splits it between two reads.
    stubFetch(
      new Response(
        byteStream([
          new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3]),
          new Uint8Array([0xa9, 0x0a, 0x0a]),
        ]),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );
    const response = await httpTransport(REQUEST, { stream: true });
    expect((await collect(response.stream!)).join('')).toBe('data: é\n\n');
  });

  it('buffers a non-event-stream body even when streaming was requested', async () => {
    stubFetch(
      new Response('{"id":"msg_1"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const response = await httpTransport(REQUEST, { stream: true });
    expect(response.body).toBe('{"id":"msg_1"}');
    expect(response.stream).toBeUndefined();
  });

  it('buffers an error response so it stays classifiable and retryable', async () => {
    stubFetch(
      new Response('{"error":{"type":"overloaded_error"}}', {
        status: 529,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const response = await httpTransport(REQUEST, { stream: true });
    expect(response.status).toBe(529);
    expect(response.body).toBe('{"error":{"type":"overloaded_error"}}');
    expect(response.stream).toBeUndefined();
  });

  it('honours a charset suffix on the content type', async () => {
    stubFetch(
      new Response(textStream('data: one\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
    );
    const response = await httpTransport(REQUEST, { stream: true });
    expect(response.stream).toBeDefined();
  });
});
