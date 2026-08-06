/**
 * Chunked HTTP response path (Task 17, subtask 17.2).
 *
 * These tests assert real incremental delivery rather than merely correct final
 * bytes: the producer is blocked until the client has *already* received the
 * first chunk, so a buffered implementation would deadlock and time out instead
 * of passing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  writeResponse,
  type GatewayResponse,
} from '../../src/gateway/server.js';

let server: Server | undefined;

/** Serve one fixed gateway response and return its URL. */
async function serve(response: GatewayResponse): Promise<string> {
  server = createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });
    void writeResponse(res, response, controller.signal);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

/** A deferred promise, used to sequence producer and consumer precisely. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('writeResponse', () => {
  it('writes a buffered response in one shot', async () => {
    const url = await serve({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    const res = await fetch(url);
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('delivers each chunk before the next is produced', async () => {
    const firstArrived = deferred();
    const secondProduced = deferred();
    async function* body(): AsyncIterable<string> {
      yield 'data: one\n\n';
      // Blocks until the client has actually received chunk one. A buffered
      // transport would never get here, failing the test by timeout.
      await firstArrived.promise;
      yield 'data: two\n\n';
      secondProduced.resolve();
    }
    const url = await serve({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: '',
      stream: body(),
    });

    const res = await fetch(url);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('data: one\n\n');
    // Only now unblock the producer: delivery was genuinely incremental.
    firstArrived.resolve();

    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe('data: two\n\n');
    await secondProduced.promise;

    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  it('sends the status and headers before the first chunk exists', async () => {
    const release = deferred();
    async function* body(): AsyncIterable<string> {
      await release.promise;
      yield 'data: late\n\n';
    }
    const url = await serve({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: '',
      stream: body(),
    });

    // fetch resolves on headers; the producer has emitted nothing yet.
    const res = await fetch(url);
    expect(res.status).toBe(200);
    release.resolve();
    expect(await res.text()).toBe('data: late\n\n');
  });

  it('stops producing when the client disconnects mid-stream', async () => {
    let produced = 0;
    let closed = false;
    // Paced like a real upstream: each chunk awaits I/O, so the handler gets a
    // turn of the event loop in which to observe the client's disconnect.
    async function* body(): AsyncIterable<string> {
      try {
        for (let i = 0; i < 100; i += 1) {
          produced += 1;
          yield `data: ${i}\n\n`;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } finally {
        // Abandoning the for-await loop closes the iterator, which is what
        // releases the upstream reader in the real transport.
        closed = true;
      }
    }
    const url = await serve({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: '',
      stream: body(),
    });

    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();

    await new Promise((resolve) => setTimeout(resolve, 100));
    const producedAtAbort = produced;
    expect(closed).toBe(true);
    // The producer stopped well short of the full script...
    expect(producedAtAbort).toBeLessThan(100);
    // ...and stays stopped rather than draining in the background.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(produced).toBe(producedAtAbort);
  });

  it('closes the response when the stream throws mid-flight', async () => {
    async function* body(): AsyncIterable<string> {
      yield 'data: one\n\n';
      throw new Error('upstream stream broke');
    }
    const url = await serve({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: '',
      stream: body(),
    });
    const res = await fetch(url);
    // The status was already committed, so the client sees a truncated stream
    // rather than an error status: post-stream retry is forbidden.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: one\n\n');
  });

  it('writes nothing when the client is already gone', async () => {
    const response: GatewayResponse = {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: '',
      stream: (async function* () {
        yield 'data: never\n\n';
      })(),
    };
    let ended = false;
    server = createServer((req, res) => {
      const controller = new AbortController();
      controller.abort(); // client vanished before the handler resolved
      void writeResponse(res, response, controller.signal).then(() => {
        ended = res.writableEnded;
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('');
    expect(ended).toBe(false);
  });
});
