/**
 * Tests for the gateway fixture recording tap (epic AIPP-1, subtask 1.3).
 *
 * The tap's value depends on two promises rather than on what it writes: that
 * it is inert when switched off, and that it cannot alter a response when
 * switched on. Most of what follows tests those, not the happy path.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tapExchange,
  corpusDirForUrl,
  caseNameFor,
  parseSseFrame,
  MAX_RECORDED_EVENTS,
  type TappableRequest,
  type TappableResponse,
} from '../../src/fixtures/gateway-tap.js';
import { lintCorpusCase } from '../../src/fixtures/corpus.js';
import { RECORD_ENV_VAR } from '../../src/fixtures/recorder.js';

const newCorpus = (): string => mkdtempSync(join(tmpdir(), 'aipp-tap-'));

function request(over: Partial<TappableRequest> = {}): TappableRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer sk-secret',
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'the quick brown fox' }],
    }),
    ...over,
  };
}

function unary(over: Partial<TappableResponse> = {}): TappableResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'a secret answer' }],
    }),
    ...over,
  };
}

async function* source(chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function drain(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of it) {
    out.push(chunk);
  }
  return out;
}

const readCase = (
  dir: string,
  provider: string,
  name: string,
  file: string,
): string => readFileSync(join(dir, provider, name, file), 'utf8');

describe('corpusDirForUrl', () => {
  it.each([
    ['/v1/messages', 'anthropic'],
    ['/v1/messages/count_tokens', 'anthropic'],
    ['/v1/chat/completions', 'openai-chat'],
    ['/v1/responses', 'openai-responses'],
    ['/v1/messages?beta=1', 'anthropic'],
  ])('maps %s to %s', (url, dir) => {
    expect(corpusDirForUrl(url)).toBe(dir);
  });

  it.each(['/health', '/dashboard', '/api/budget', '/v1/models'])(
    'does not record %s',
    (url) => {
      expect(corpusDirForUrl(url)).toBeNull();
    },
  );
});

describe('inertness when disabled', () => {
  it('returns the identical response object when no corpus dir is set', () => {
    const response = unary();
    expect(tapExchange(request(), response, null)).toBe(response);
  });

  it('returns the identical response object for a non-corpus route', () => {
    const response = unary();
    const out = tapExchange(request({ url: '/health' }), response, newCorpus());
    expect(out).toBe(response);
  });

  it('writes nothing for a non-corpus route', () => {
    const dir = newCorpus();
    tapExchange(request({ url: '/health' }), unary(), dir);
    expect(existsSync(join(dir, 'anthropic'))).toBe(false);
  });

  it('honours the environment variable when no dir is passed', () => {
    const dir = newCorpus();
    process.env[RECORD_ENV_VAR] = dir;
    try {
      tapExchange(request(), unary());
      expect(existsSync(join(dir, 'anthropic'))).toBe(true);
    } finally {
      delete process.env[RECORD_ENV_VAR];
    }
  });

  afterEach(() => {
    delete process.env[RECORD_ENV_VAR];
  });
});

describe('unary capture', () => {
  it('writes a scrubbed request and response', () => {
    const dir = newCorpus();
    tapExchange(request(), unary(), dir);
    const req = readCase(
      dir,
      'anthropic',
      'claude-opus-5-plain-text',
      'request.json',
    );
    const res = readCase(
      dir,
      'anthropic',
      'claude-opus-5-plain-text',
      'response.json',
    );

    // Structure survives, content does not.
    expect(req).toContain('"model": "claude-opus-5"');
    expect(req).toContain('"role": "user"');
    expect(req).not.toContain('the quick brown fox');
    expect(res).toContain('"type": "text"');
    expect(res).not.toContain('a secret answer');
  });

  it('drops the authorization header rather than recording it', () => {
    const dir = newCorpus();
    tapExchange(request(), unary(), dir);
    const req = readCase(
      dir,
      'anthropic',
      'claude-opus-5-plain-text',
      'request.json',
    );
    expect(req).not.toContain('sk-secret');
    expect(req.toLowerCase()).not.toContain('authorization');
  });

  it('produces a case that passes the committed corpus linter', () => {
    const dir = newCorpus();
    tapExchange(request(), unary(), dir);
    const result = lintCorpusCase(
      'anthropic',
      join(dir, 'anthropic', 'claude-opus-5-plain-text'),
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('does not write a response body alongside a stream', async () => {
    const dir = newCorpus();
    const out = tapExchange(
      request(),
      {
        ...unary({ body: '' }),
        stream: source(['event: message_stop\ndata: {}\n\n']),
      },
      dir,
    );
    await drain(out.stream!);
    const caseDir = join(dir, 'anthropic', 'claude-opus-5-plain-text-stream');
    expect(existsSync(join(caseDir, 'stream.jsonl'))).toBe(true);
    expect(existsSync(join(caseDir, 'response.json'))).toBe(false);
  });
});

describe('case naming', () => {
  const body = (o: Record<string, unknown>): string =>
    JSON.stringify({ model: 'm', ...o });

  it.each([
    [body({}), 200, '/v1/messages', 'm-plain-text'],
    [body({ tools: [{ name: 't' }] }), 200, '/v1/messages', 'm-tools'],
    [
      body({ thinking: { type: 'enabled' } }),
      200,
      '/v1/messages',
      'm-extended-thinking',
    ],
    [body({ system: 'x' }), 200, '/v1/messages', 'm-system-blocks'],
    [body({}), 429, '/v1/messages', 'm-error-429'],
    [body({}), 200, '/v1/messages/count_tokens', 'm-count-tokens'],
  ])('names the case %#', (b, status, url, expected) => {
    expect(caseNameFor(url, b, status, false)).toBe(expected);
  });

  it('suffixes streaming cases so they cannot collide with unary ones', () => {
    expect(caseNameFor('/v1/messages', body({}), 200, true)).toBe(
      'm-plain-text-stream',
    );
  });

  it('treats a disabled thinking block as plain text', () => {
    expect(
      caseNameFor(
        '/v1/messages',
        body({ thinking: { type: 'disabled' } }),
        200,
        false,
      ),
    ).toBe('m-plain-text');
  });

  it('survives an unparseable body', () => {
    expect(caseNameFor('/v1/messages', 'not json', 200, false)).toBe(
      'unknown-model-plain-text',
    );
  });
});

describe('parseSseFrame', () => {
  it('reads an explicit event name', () => {
    expect(parseSseFrame('event: message_start\ndata: {"a":1}')).toEqual({
      event: 'message_start',
      data: { a: 1 },
    });
  });

  it('defaults a data-only frame to the SSE default event name', () => {
    // OpenAI chat streams carry no event line; dropping them would lose the
    // entire stream, and the linter requires `event` to be a string.
    expect(parseSseFrame('data: {"a":1}')).toEqual({
      event: 'message',
      data: { a: 1 },
    });
  });

  it('keeps [DONE] verbatim', () => {
    expect(parseSseFrame('data: [DONE]')).toEqual({
      event: 'message',
      data: '[DONE]',
    });
  });

  it('keeps an unparseable payload rather than dropping the event', () => {
    expect(parseSseFrame('data: {oops')).toEqual({
      event: 'message',
      data: '{oops',
    });
  });

  it('ignores a frame with no data line', () => {
    expect(parseSseFrame(': keep-alive comment')).toBeNull();
  });
});

describe('streaming capture', () => {
  const CHUNKS = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"delta":{"text":"hello"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  it('passes every chunk through byte-identical', async () => {
    const dir = newCorpus();
    const out = tapExchange(
      request(),
      { ...unary({ body: '' }), stream: source(CHUNKS) },
      dir,
    );
    expect(await drain(out.stream!)).toEqual(CHUNKS);
  });

  it('records the event sequence in order', async () => {
    const dir = newCorpus();
    const out = tapExchange(
      request(),
      { ...unary({ body: '' }), stream: source(CHUNKS) },
      dir,
    );
    await drain(out.stream!);
    const lines = readCase(
      dir,
      'anthropic',
      'claude-opus-5-plain-text-stream',
      'stream.jsonl',
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string });
    expect(lines.map((l) => l.event)).toEqual([
      'message_start',
      'content_block_delta',
      'message_stop',
    ]);
  });

  it('scrubs streamed content', async () => {
    const dir = newCorpus();
    const out = tapExchange(
      request(),
      { ...unary({ body: '' }), stream: source(CHUNKS) },
      dir,
    );
    await drain(out.stream!);
    const jsonl = readCase(
      dir,
      'anthropic',
      'claude-opus-5-plain-text-stream',
      'stream.jsonl',
    );
    expect(jsonl).not.toContain('hello');
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const dir = newCorpus();
    const split = ['event: message_st', 'art\ndata: {"a":1}\n', '\n'];
    const out = tapExchange(
      request(),
      { ...unary({ body: '' }), stream: source(split) },
      dir,
    );
    await drain(out.stream!);
    const jsonl = readCase(
      dir,
      'anthropic',
      'claude-opus-5-plain-text-stream',
      'stream.jsonl',
    );
    expect(JSON.parse(jsonl.trim()) as { event: string }).toMatchObject({
      event: 'message_start',
    });
  });

  it('records what it saw when the client hangs up mid-stream', async () => {
    const dir = newCorpus();
    const out = tapExchange(
      request(),
      { ...unary({ body: '' }), stream: source(CHUNKS) },
      dir,
    );
    // Consume one chunk then abandon the iterator, as writeResponse does when
    // the socket closes.
    for await (const _chunk of out.stream!) {
      void _chunk;
      break;
    }
    const file = join(
      dir,
      'anthropic',
      'claude-opus-5-plain-text-stream',
      'stream.jsonl',
    );
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('writes no case when the client disconnects before any event', async () => {
    const dir = newCorpus();
    const out = tapExchange(
      request(),
      { ...unary({ body: '' }), stream: source(CHUNKS) },
      dir,
    );
    await out.stream![Symbol.asyncIterator]().return?.(undefined);
    expect(
      existsSync(join(dir, 'anthropic', 'claude-opus-5-plain-text-stream')),
    ).toBe(false);
  });

  it('caps recorded events without capping delivery', async () => {
    const dir = newCorpus();
    const many = Array.from(
      { length: MAX_RECORDED_EVENTS + 50 },
      (_, i) => `event: e\ndata: {"i":${i}}\n\n`,
    );
    const out = tapExchange(
      request(),
      { ...unary({ body: '' }), stream: source(many) },
      dir,
    );
    const delivered = await drain(out.stream!);

    expect(delivered).toHaveLength(many.length); // delivery untouched
    const lines = readCase(
      dir,
      'anthropic',
      'claude-opus-5-plain-text-stream',
      'stream.jsonl',
    )
      .trim()
      .split('\n');
    expect(lines).toHaveLength(MAX_RECORDED_EVENTS);
  });

  it('produces a streaming case that passes the corpus linter', async () => {
    const dir = newCorpus();
    const out = tapExchange(
      request(),
      { ...unary({ body: '' }), stream: source(CHUNKS) },
      dir,
    );
    await drain(out.stream!);
    const result = lintCorpusCase(
      'anthropic',
      join(dir, 'anthropic', 'claude-opus-5-plain-text-stream'),
    );
    expect(result.errors).toEqual([]);
  });
});

describe('recording failures never reach the client', () => {
  it('does not throw when the corpus root is not a directory', () => {
    const file = join(newCorpus(), 'not-a-dir');
    writeFileSync(file, 'x', 'utf8');
    expect(() => tapExchange(request(), unary(), file)).not.toThrow();
  });

  it('still delivers the whole stream when the corpus root is unusable', async () => {
    const file = join(newCorpus(), 'not-a-dir');
    writeFileSync(file, 'x', 'utf8');
    const chunks = ['event: a\ndata: {}\n\n'];
    const out = tapExchange(
      request(),
      { ...unary({ body: '' }), stream: source(chunks) },
      file,
    );
    await expect(drain(out.stream!)).resolves.toEqual(chunks);
  });
});
