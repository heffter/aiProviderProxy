/**
 * Unit tests for Responses <-> Chat translation and reasoning (AIPP-7, 7.5).
 */

import { describe, it, expect } from 'vitest';
import { parseResponsesRequest } from '../../../src/protocols/openai-responses/request.js';
import {
  responsesToChatBody,
  mapReasoningControls,
  chatResponseToCanonical,
  chatUsageToCanonical,
  finishReasonToStatus,
} from '../../../src/protocols/openai-responses/translate.js';
import {
  encodeResponsesStream,
  streamEventsForResult,
} from '../../../src/protocols/openai-responses/stream-encoder.js';

function parse(body: Record<string, unknown>) {
  const res = parseResponsesRequest({ model: 'm', input: 'hi', ...body });
  if (!res.ok) {
    throw new Error(`unexpected parse failure: ${res.error.error.message}`);
  }
  return res.request;
}

const caps = { reasoningCapable: true, toolsCapable: true };

describe('responsesToChatBody — messages', () => {
  it('maps instructions and a string input to system + user messages', () => {
    const body = responsesToChatBody(
      parse({ input: 'hello', instructions: 'be terse' }),
      'deepseek-chat',
      { provider: 'deepseek', ...caps },
    );
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ]);
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(false);
  });

  it('maps developer role to system and collapses single text parts', () => {
    const body = responsesToChatBody(
      parse({
        input: [
          { type: 'message', role: 'developer', content: 'sys' },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hi' }],
          },
        ],
      }),
      'm',
      { provider: 'deepseek', ...caps },
    );
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('maps prior function calls and outputs to assistant tool_calls + tool msgs', () => {
    const body = responsesToChatBody(
      parse({
        input: [
          { type: 'message', role: 'user', content: 'run it' },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '{"city":"SF"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: '72F',
          },
        ],
      }),
      'm',
      { provider: 'deepseek', ...caps },
    );
    expect(body.messages).toEqual([
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"SF"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '72F' },
    ]);
  });

  it('maps an input_image part to a chat image_url part', () => {
    const body = responsesToChatBody(
      parse({
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'what is this' },
              { type: 'input_image', image_url: 'https://x/y.png' },
            ],
          },
        ],
      }),
      'm',
      { provider: 'deepseek', ...caps },
    );
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
    ]);
  });
});

describe('responsesToChatBody — tools and limits', () => {
  it('maps tools, tool_choice, limits, and gates parallel calls', () => {
    const body = responsesToChatBody(
      parse({
        tools: [
          { type: 'function', name: 'f', parameters: { type: 'object' } },
        ],
        tool_choice: { type: 'function', name: 'f' },
        max_output_tokens: 128,
        temperature: 0.3,
        top_p: 0.9,
        parallel_tool_calls: true,
      }),
      'm',
      { provider: 'deepseek', reasoningCapable: false, toolsCapable: true },
    );
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'f', parameters: { type: 'object' } },
      },
    ]);
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'f' },
    });
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.9);
    expect(body.parallel_tool_calls).toBe(true);
  });

  it('forces parallel_tool_calls false when the model lacks the capability', () => {
    const body = responsesToChatBody(
      parse({ parallel_tool_calls: true }),
      'm',
      { provider: 'deepseek', reasoningCapable: true, toolsCapable: false },
    );
    expect(body.parallel_tool_calls).toBe(false);
  });
});

describe('reasoning controls', () => {
  it('maps effort to reasoning_effort for an OpenAI-style chat upstream', () => {
    expect(
      mapReasoningControls('high', {
        provider: 'deepseek',
        reasoningCapable: true,
      }),
    ).toEqual({ reasoning_effort: 'high' });
  });

  it('adds the GLM thinking control for Z.ai', () => {
    expect(
      mapReasoningControls('medium', {
        provider: 'zai',
        reasoningCapable: true,
      }),
    ).toEqual({ reasoning_effort: 'medium', thinking: { type: 'enabled' } });
  });

  it('drops reasoning when the model is not reasoning-capable', () => {
    expect(
      mapReasoningControls('high', {
        provider: 'zai',
        reasoningCapable: false,
      }),
    ).toEqual({});
  });

  it('drops reasoning when the client asked for none', () => {
    expect(
      mapReasoningControls(undefined, {
        provider: 'zai',
        reasoningCapable: true,
      }),
    ).toEqual({});
  });

  it('does not emit reasoning fields on the chat body when gated off', () => {
    const body = responsesToChatBody(
      parse({ reasoning: { effort: 'high' } }),
      'm',
      { provider: 'deepseek', reasoningCapable: false, toolsCapable: true },
    );
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });
});

describe('chat usage extraction', () => {
  it('extracts input/output with cached and reasoning counters', () => {
    expect(
      chatUsageToCanonical({
        prompt_tokens: 100,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 12 },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 30,
      reasoningTokens: 12,
    });
  });

  it('returns undefined when usage is absent', () => {
    expect(chatUsageToCanonical(undefined)).toBeUndefined();
  });
});

describe('finishReasonToStatus', () => {
  it('maps length to incomplete/max_output_tokens', () => {
    expect(finishReasonToStatus('length')).toEqual({
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
    });
  });
  it('maps content_filter to incomplete/content_filter', () => {
    expect(finishReasonToStatus('content_filter')).toEqual({
      status: 'incomplete',
      incompleteReason: 'content_filter',
    });
  });
  it('maps stop/tool_calls to completed', () => {
    expect(finishReasonToStatus('stop').status).toBe('completed');
    expect(finishReasonToStatus('tool_calls').status).toBe('completed');
  });
});

describe('chatResponseToCanonical', () => {
  it('reconstructs a text result with usage', () => {
    const result = chatResponseToCanonical(
      {
        id: 'chatcmpl-1',
        choices: [{ finish_reason: 'stop', message: { content: 'hi there' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
      'deepseek-chat',
    );
    expect(result).toEqual({
      id: 'chatcmpl-1',
      model: 'deepseek-chat',
      status: 'completed',
      incompleteReason: undefined,
      outputs: [{ kind: 'message', text: 'hi there' }],
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cachedInputTokens: undefined,
        reasoningTokens: undefined,
      },
    });
  });

  it('reconstructs tool calls preserving ids', () => {
    const result = chatResponseToCanonical(
      {
        id: 'c1',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_9',
                  type: 'function',
                  function: { name: 'f', arguments: '{"x":1}' },
                },
              ],
            },
          },
        ],
      },
      'm',
    );
    expect(result.outputs).toEqual([
      {
        kind: 'function_call',
        callId: 'call_9',
        name: 'f',
        arguments: '{"x":1}',
      },
    ]);
    expect(result.status).toBe('completed');
  });

  it('maps a length finish to an incomplete result', () => {
    const result = chatResponseToCanonical(
      {
        choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
      },
      'm',
    );
    expect(result.status).toBe('incomplete');
    expect(result.incompleteReason).toBe('max_output_tokens');
  });
});

describe('streamEventsForResult round-trip', () => {
  it('turns a reconstructed result into an encodable event script', () => {
    const result = chatResponseToCanonical(
      {
        id: 'c1',
        choices: [{ finish_reason: 'stop', message: { content: 'hello' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      },
      'm',
    );
    const events = streamEventsForResult(result);
    expect(events[0]).toEqual({
      type: 'response_created',
      model: 'm',
      id: 'c1',
    });
    expect(events[events.length - 1]).toMatchObject({
      type: 'response_done',
      status: 'completed',
    });
    // The event script encodes without throwing (invariants satisfied).
    const sse = encodeResponsesStream(events, {
      genId: (() => {
        let n = 0;
        return () => `id${(n += 1)}`;
      })(),
      now: () => 1_700_000_000_000,
    });
    expect(sse).toContain('event: response.completed');
    expect(sse).toContain('"output_text":"hello"');
  });
});
