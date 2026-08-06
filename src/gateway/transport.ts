/**
 * Default HTTP transport for the gateway (epic AIPP-6, subtask 6.2; streaming
 * added in Task 17, subtask 17.1).
 *
 * A thin fetch-based implementation of the provider {@link Transport}: it issues
 * the request the adapter serialized and reads the response body as text. It is
 * injectable so the gateway is tested against mock upstreams without real
 * network access.
 *
 * When the caller asks for a streaming body ({@link TransportOptions.stream})
 * and the upstream answers with a successful event-stream response, the body is
 * exposed as an async iterable of decoded text chunks instead of being pre-read.
 * Everything else -- notably every error status -- stays fully buffered, which
 * is what keeps error classification and pre-stream retry unchanged: the gateway
 * cannot have emitted a byte to the client before it has seen the status.
 */

import type { Transport } from '../providers/types.js';

/** Content type that marks a body worth streaming rather than buffering. */
const EVENT_STREAM = 'text/event-stream';

/**
 * Decode a byte stream into text chunks, yielding each chunk as it arrives.
 *
 * Uses a streaming {@link TextDecoder} so a multi-byte UTF-8 character split
 * across two network chunks is reassembled rather than corrupted.
 *
 * @param body The response byte stream.
 * @returns Decoded text chunks in arrival order.
 */
async function* decodeTextChunks(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        yield text;
      }
    }
    // Flush any character left pending in the decoder's internal state.
    const tail = decoder.decode();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    // Releasing on early exit (client disconnect, downstream throw) lets the
    // underlying connection be torn down instead of leaking a locked reader.
    reader.releaseLock();
  }
}

/** Perform provider requests using the global fetch implementation. */
export const httpTransport: Transport = async (request, options) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: options?.signal,
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const streamable =
    options?.stream === true &&
    response.ok &&
    response.body !== null &&
    (headers['content-type'] ?? '').includes(EVENT_STREAM);
  if (streamable) {
    return {
      status: response.status,
      headers,
      body: '',
      stream: decodeTextChunks(response.body as ReadableStream<Uint8Array>),
    };
  }
  const body = await response.text();
  return { status: response.status, headers, body };
};
