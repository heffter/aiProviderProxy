/**
 * Anthropic upstream SSE decoder (Task 17, subtask 17.4).
 *
 * The decoder is required to be *total*: anything it does not recognize -- a
 * ping, a future event type, a malformed or truncated payload -- must decode to
 * undefined and be skipped, never throw. A throw here would abort a stream that
 * is otherwise fine, so these defensive paths are the point of the module.
 */

import { describe, it, expect } from 'vitest';
import { decodeAnthropicStreamEvent } from '../../../src/protocols/anthropic/stream-decoder.js';

/** Build a parsed SSE event as `parseStreamEvent` would return it. */
function event(name: string, data: unknown) {
  return { event: name, data };
}

describe('decodeAnthropicStreamEvent', () => {
  it('decodes message_start with ids, model and usage', () => {
    expect(
      decodeAnthropicStreamEvent(
        event('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_1',
            model: 'claude-sonnet-4',
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 4,
            },
          },
        }),
      ),
    ).toEqual({
      type: 'message_start',
      id: 'msg_1',
      model: 'claude-sonnet-4',
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
      },
    });
  });

  it('omits usage entirely when the upstream reported none', () => {
    const decoded = decodeAnthropicStreamEvent(
      event('message_start', { type: 'message_start', message: { id: 'm' } }),
    );
    expect(decoded).toMatchObject({ type: 'message_start' });
    expect((decoded as { usage?: unknown }).usage).toBeUndefined();
  });

  it('decodes each content block kind', () => {
    expect(
      decodeAnthropicStreamEvent(
        event('content_block_start', {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'text' },
        }),
      ),
    ).toEqual({ type: 'block_start', index: 2, block: { kind: 'text' } });

    expect(
      decodeAnthropicStreamEvent(
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'bash' },
        }),
      ),
    ).toEqual({
      type: 'block_start',
      index: 0,
      block: { kind: 'tool_use', id: 't1', name: 'bash' },
    });

    // redacted_thinking is treated as a thinking block.
    for (const type of ['thinking', 'redacted_thinking']) {
      expect(
        decodeAnthropicStreamEvent(
          event('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type },
          }),
        ),
      ).toMatchObject({ block: { kind: 'thinking' } });
    }
  });

  it('defaults a tool_use block missing its id or name to empty strings', () => {
    expect(
      decodeAnthropicStreamEvent(
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use' },
        }),
      ),
    ).toEqual({
      type: 'block_start',
      index: 0,
      block: { kind: 'tool_use', id: '', name: '' },
    });
  });

  it('skips a content block of an unrecognized type', () => {
    expect(
      decodeAnthropicStreamEvent(
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'future_block' },
        }),
      ),
    ).toBeUndefined();
  });

  it('decodes each delta kind', () => {
    const delta = (d: unknown) =>
      decodeAnthropicStreamEvent(
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: d,
        }),
      );
    expect(delta({ type: 'text_delta', text: 'hi' })).toEqual({
      type: 'text_delta',
      index: 1,
      text: 'hi',
    });
    expect(delta({ type: 'input_json_delta', partial_json: '{"a":' })).toEqual({
      type: 'json_delta',
      index: 1,
      partial: '{"a":',
    });
    expect(delta({ type: 'thinking_delta', thinking: 'hmm' })).toEqual({
      type: 'thinking_delta',
      index: 1,
      text: 'hmm',
    });
    expect(delta({ type: 'signature_delta', signature: 'sig' })).toEqual({
      type: 'signature_delta',
      index: 1,
      signature: 'sig',
    });
    expect(delta({ type: 'future_delta' })).toBeUndefined();
  });

  it('substitutes an empty string for a delta missing its payload', () => {
    expect(
      decodeAnthropicStreamEvent(
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta' },
        }),
      ),
    ).toEqual({ type: 'text_delta', index: 0, text: '' });
  });

  it('defaults a missing block index to zero', () => {
    expect(
      decodeAnthropicStreamEvent(
        event('content_block_stop', { type: 'content_block_stop' }),
      ),
    ).toEqual({ type: 'block_stop', index: 0 });
  });

  it('decodes message_delta stop reason and output usage', () => {
    expect(
      decodeAnthropicStreamEvent(
        event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens' },
          usage: { output_tokens: 42 },
        }),
      ),
    ).toEqual({
      type: 'message_delta',
      stopReason: 'max_tokens',
      usage: {
        inputTokens: undefined,
        outputTokens: 42,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
    });
  });

  it('decodes an error frame into a message', () => {
    expect(
      decodeAnthropicStreamEvent(
        event('error', {
          type: 'error',
          error: { type: 'overloaded_error', message: 'slow down' },
        }),
      ),
    ).toEqual({ type: 'error', message: 'slow down' });
  });

  it('falls back to a generic message for an error with no text', () => {
    expect(
      decodeAnthropicStreamEvent(event('error', { type: 'error' })),
    ).toEqual({ type: 'error', message: 'upstream stream error' });
  });

  it('skips a ping and any unknown event type', () => {
    expect(
      decodeAnthropicStreamEvent(event('ping', { type: 'ping' })),
    ).toBeUndefined();
    expect(
      decodeAnthropicStreamEvent(event('whatever', { type: 'whatever' })),
    ).toBeUndefined();
  });

  it('falls back to the event name when the payload carries no type', () => {
    expect(decodeAnthropicStreamEvent(event('message_stop', {}))).toEqual({
      type: 'message_stop',
    });
  });

  it('never throws on a malformed payload', () => {
    const malformed: unknown[] = [
      null,
      'a bare string',
      42,
      { type: 'message_start' }, // no message object
      { type: 'message_start', message: 'not-an-object' },
      { type: 'content_block_start', content_block: null },
      { type: 'content_block_delta', delta: null },
      { type: 'message_delta', delta: null, usage: 'nope' },
      { type: 'message_start', message: { usage: { input_tokens: 'ten' } } },
    ];
    for (const data of malformed) {
      expect(() =>
        decodeAnthropicStreamEvent(event('content_block_delta', data)),
      ).not.toThrow();
    }
  });

  it('ignores non-numeric usage fields rather than propagating them', () => {
    const decoded = decodeAnthropicStreamEvent(
      event('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 'ten', output_tokens: 5 } },
      }),
    );
    expect(decoded).toMatchObject({
      usage: { inputTokens: undefined, outputTokens: 5 },
    });
  });
});
