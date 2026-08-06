/**
 * Incremental SSE framing (Task 17, subtask 17.1).
 *
 * The splitter must re-assemble whole SSE blocks from chunk boundaries that fall
 * anywhere -- mid-frame, mid-line, even between the two newlines of a separator
 * -- and must never hand a downstream parser a partial block.
 */

import { describe, it, expect } from 'vitest';
import { SseFrameSplitter, sseFrames } from '../../src/gateway/sse.js';

/** Feed a whole body one character at a time: the worst-case chunking. */
function splitByCharacter(body: string): string[] {
  const splitter = new SseFrameSplitter();
  const frames: string[] = [];
  for (const char of body) {
    frames.push(...splitter.push(char));
  }
  frames.push(...splitter.flush());
  return frames;
}

/** An async iterable over fixed chunks, standing in for a network body. */
async function* chunksOf(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('SseFrameSplitter', () => {
  it('emits a frame only once its blank-line terminator arrives', () => {
    const splitter = new SseFrameSplitter();
    expect(splitter.push('event: message_start\n')).toEqual([]);
    expect(splitter.push('data: {"a":1}')).toEqual([]);
    expect(splitter.push('\n\n')).toEqual([
      'event: message_start\ndata: {"a":1}',
    ]);
  });

  it('emits several frames from a single chunk, in order', () => {
    const splitter = new SseFrameSplitter();
    expect(splitter.push('data: one\n\ndata: two\n\ndata: three\n\n')).toEqual([
      'data: one',
      'data: two',
      'data: three',
    ]);
  });

  it('handles a chunk boundary inside the separator', () => {
    const splitter = new SseFrameSplitter();
    expect(splitter.push('data: one\n')).toEqual([]);
    // The trailing "\n" is retained: it may yet be half of a separator.
    expect(splitter.push('\ndata: two\n\n')).toEqual([
      'data: one',
      'data: two',
    ]);
  });

  it('reassembles a body chunked one character at a time', () => {
    const body =
      'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\ndata: [DONE]\n\n';
    expect(splitByCharacter(body)).toEqual([
      'event: a\ndata: {"x":1}',
      'event: b\ndata: {"y":2}',
      'data: [DONE]',
    ]);
  });

  it('accepts CRLF line endings', () => {
    const splitter = new SseFrameSplitter();
    expect(splitter.push('data: one\r\n\r\ndata: two\r\n\r\n')).toEqual([
      'data: one',
      'data: two',
    ]);
  });

  it('skips blank padding between frames', () => {
    const splitter = new SseFrameSplitter();
    expect(splitter.push('data: one\n\n\n\ndata: two\n\n')).toEqual([
      'data: one',
      'data: two',
    ]);
  });

  it('ignores an empty chunk', () => {
    const splitter = new SseFrameSplitter();
    expect(splitter.push('')).toEqual([]);
    expect(splitter.push('data: one\n\n')).toEqual(['data: one']);
  });

  it('releases an unterminated trailing frame on flush', () => {
    const splitter = new SseFrameSplitter();
    expect(splitter.push('data: one\n\ndata: truncated')).toEqual([
      'data: one',
    ]);
    expect(splitter.flush()).toEqual(['data: truncated']);
    // Flushing is idempotent: the buffer is cleared.
    expect(splitter.flush()).toEqual([]);
  });

  it('flushes nothing when the body ended on a separator', () => {
    const splitter = new SseFrameSplitter();
    splitter.push('data: one\n\n');
    expect(splitter.flush()).toEqual([]);
  });

  it('does not carry state across separate streams', () => {
    const first = new SseFrameSplitter();
    first.push('data: partial');
    const second = new SseFrameSplitter();
    expect(second.push('data: clean\n\n')).toEqual(['data: clean']);
  });
});

describe('sseFrames', () => {
  it('yields frames as soon as each is terminated', async () => {
    const frames: string[] = [];
    for await (const frame of sseFrames(
      chunksOf('data: one\n\ndata: t', 'wo\n\n'),
    )) {
      frames.push(frame);
    }
    expect(frames).toEqual(['data: one', 'data: two']);
  });

  it('yields the trailing partial frame when the stream ends early', async () => {
    const frames: string[] = [];
    for await (const frame of sseFrames(chunksOf('data: one\n\ndata: cut'))) {
      frames.push(frame);
    }
    expect(frames).toEqual(['data: one', 'data: cut']);
  });
});
