/**
 * Unit tests for Anthropic <-> OpenAI translation (AIPP-6, subtask 6.4).
 */

import { describe, it, expect } from 'vitest';
import { parseMessagesRequest } from '../../../src/protocols/anthropic/messages-request.js';
import {
  anthropicToOpenAIRequest,
  openAIFinishToAnthropicStop,
  openAIResponseToAnthropic,
} from '../../../src/protocols/anthropic/translate.js';

function parse(body: Record<string, unknown>) {
  const res = parseMessagesRequest({
    model: 'claude-sonnet-4',
    max_tokens: 1024,
    ...body,
  });
  if (!res.ok) {
    throw new Error(`fixture invalid: ${res.error.error.message}`);
  }
  return res.request;
}

describe('anthropicToOpenAIRequest', () => {
  it('maps system, text, and temperature', () => {
    const { body } = anthropicToOpenAIRequest(
      parse({
        system: 'be terse',
        temperature: 0.2,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
      'gpt-4o',
    );
    expect(body.model).toBe('gpt-4o');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(1024);
  });

  it('maps tool_use to tool_calls and tool_result to a tool message', () => {
    const { body } = anthropicToOpenAIRequest(
      parse({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'search',
                input: { q: 'x' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: 'result' },
            ],
          },
        ],
      }),
      'gpt-4o',
    );
    expect(body.messages[0].tool_calls?.[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'search', arguments: '{"q":"x"}' },
    });
    expect(body.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'result',
    });
  });

  it('maps tools (input_schema -> parameters) and tool_choice', () => {
    const { body } = anthropicToOpenAIRequest(
      parse({
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          {
            name: 'get_weather',
            description: 'w',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        tool_choice: { type: 'tool', name: 'get_weather' },
      }),
      'gpt-4o',
    );
    expect(body.tools?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'w',
        parameters: { type: 'object', properties: {} },
      },
    });
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  it('maps tool_choice auto/any', () => {
    expect(
      anthropicToOpenAIRequest(
        parse({
          messages: [{ role: 'user', content: 'x' }],
          tool_choice: { type: 'auto' },
        }),
        'm',
      ).body.tool_choice,
    ).toBe('auto');
    expect(
      anthropicToOpenAIRequest(
        parse({
          messages: [{ role: 'user', content: 'x' }],
          tool_choice: { type: 'any' },
        }),
        'm',
      ).body.tool_choice,
    ).toBe('required');
  });

  it('drops thinking and cache_control with notes', () => {
    const result = anthropicToOpenAIRequest(
      parse({
        system: [
          { type: 'text', text: 'ctx', cache_control: { type: 'ephemeral' } },
        ],
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'secret reasoning' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      }),
      'gpt-4o',
    );
    expect(result.droppedThinking).toBe(true);
    expect(result.droppedCacheControl).toBe(true);
    // thinking content is not forwarded
    expect(JSON.stringify(result.body)).not.toContain('secret reasoning');
  });
});

describe('openAIResponseToAnthropic', () => {
  it('maps text and tool_calls into content blocks with usage and stop_reason', () => {
    const msg = openAIResponseToAnthropic(
      {
        id: 'chatcmpl-1',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'here',
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"q":"y"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 25 },
      },
      'gpt-4o',
    );
    expect(msg).toMatchObject({
      id: 'chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-4o',
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 25 },
    });
    expect(msg.content[0]).toEqual({ type: 'text', text: 'here' });
    expect(msg.content[1]).toEqual({
      type: 'tool_use',
      id: 'c1',
      name: 'search',
      input: { q: 'y' },
    });
  });
});

describe('openAIFinishToAnthropicStop', () => {
  it('maps finish reasons', () => {
    expect(openAIFinishToAnthropicStop('stop')).toBe('end_turn');
    expect(openAIFinishToAnthropicStop('length')).toBe('max_tokens');
    expect(openAIFinishToAnthropicStop('tool_calls')).toBe('tool_use');
    expect(openAIFinishToAnthropicStop(undefined)).toBe('end_turn');
  });
});
