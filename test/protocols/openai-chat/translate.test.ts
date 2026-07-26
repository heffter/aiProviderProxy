/**
 * Unit tests for Chat <-> Anthropic translation and the two legacy fixes
 * (cache tokens preserved; thinking diagnosed, not dropped) (AIPP-8, 8.2).
 */

import { describe, it, expect } from 'vitest';
import { parseChatRequest } from '../../../src/protocols/openai-chat/request.js';
import {
  chatToAnthropicRequest,
  anthropicResponseToChat,
  anthropicUsageToChat,
  anthropicStopToChatFinish,
  collectThinkingDiagnostics,
} from '../../../src/protocols/openai-chat/translate.js';

function parse(body: Record<string, unknown>) {
  const res = parseChatRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    ...body,
  });
  if (!res.ok) {
    throw new Error(`unexpected parse failure: ${res.error.error.message}`);
  }
  return res.request;
}

describe('chatToAnthropicRequest', () => {
  it('hoists system/developer messages into the system field', () => {
    const body = chatToAnthropicRequest(
      parse({
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'developer', content: 'and precise' },
          { role: 'user', content: 'hello' },
        ],
      }),
      'claude-sonnet-4',
    );
    expect(body.system).toBe('be terse\nand precise');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(body.max_tokens).toBe(4096); // default when omitted
  });

  it('maps assistant tool_calls and tool results to Anthropic blocks', () => {
    const body = chatToAnthropicRequest(
      parse({
        messages: [
          { role: 'user', content: 'run it' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '12:00' },
        ],
        max_tokens: 256,
      }),
      'claude-sonnet-4',
    );
    expect(body.max_tokens).toBe(256);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'get_time',
          input: { tz: 'UTC' },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '12:00' },
      ],
    });
  });

  it('maps tools and tool_choice', () => {
    const body = chatToAnthropicRequest(
      parse({
        tools: [
          {
            type: 'function',
            function: {
              name: 'f',
              description: 'do f',
              parameters: { type: 'object' },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'f' } },
      }),
      'claude-sonnet-4',
    );
    expect(body.tools).toEqual([
      { name: 'f', description: 'do f', input_schema: { type: 'object' } },
    ]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'f' });
  });
});

describe('finish reason and usage mapping', () => {
  it('maps stop reasons', () => {
    expect(anthropicStopToChatFinish('max_tokens')).toBe('length');
    expect(anthropicStopToChatFinish('tool_use')).toBe('tool_calls');
    expect(anthropicStopToChatFinish('end_turn')).toBe('stop');
  });

  it('preserves cache-read tokens (fix 1)', () => {
    expect(
      anthropicUsageToChat({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
      }),
    ).toEqual({ promptTokens: 100, completionTokens: 20, cachedTokens: 40 });
  });
});

describe('thinking diagnostics (fix 2)', () => {
  it('counts thinking and redacted_thinking blocks by kind', () => {
    expect(
      collectThinkingDiagnostics([
        { type: 'thinking', thinking: 'secret' },
        { type: 'thinking', thinking: 'more' },
        { type: 'redacted_thinking', data: 'x' },
        { type: 'text', text: 'visible' },
      ]),
    ).toEqual([
      { namespace: 'anthropic.thinking', kind: 'thinking', count: 2 },
      { namespace: 'anthropic.thinking', kind: 'redacted_thinking', count: 1 },
    ]);
  });

  it('returns no diagnostics when there is no thinking', () => {
    expect(collectThinkingDiagnostics([{ type: 'text', text: 'hi' }])).toEqual(
      [],
    );
  });
});

describe('anthropicResponseToChat', () => {
  it('reconstructs text + cache usage and diagnoses thinking, never leaking it', () => {
    const { result, diagnostics } = anthropicResponseToChat(
      {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'do-not-export-this' },
          { type: 'text', text: 'Hello.' },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 8,
        },
      },
      'claude-sonnet-4',
    );
    expect(result).toEqual({
      id: 'msg_1',
      model: 'claude-sonnet-4',
      finishReason: 'stop',
      text: 'Hello.',
      toolCalls: undefined,
      usage: { promptTokens: 10, completionTokens: 3, cachedTokens: 8 },
    });
    expect(diagnostics).toEqual([
      { namespace: 'anthropic.thinking', kind: 'thinking', count: 1 },
    ]);
    // The reasoning text never appears anywhere in the reconstructed output.
    expect(JSON.stringify({ result, diagnostics })).not.toContain(
      'do-not-export-this',
    );
  });

  it('reconstructs tool_use blocks into tool calls', () => {
    const { result } = anthropicResponseToChat(
      {
        id: 'msg_2',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'get_time',
            input: { tz: 'UTC' },
          },
        ],
        stop_reason: 'tool_use',
      },
      'claude-sonnet-4',
    );
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      { id: 'tu_1', name: 'get_time', arguments: '{"tz":"UTC"}' },
    ]);
    expect(result.text).toBeUndefined();
  });
});
