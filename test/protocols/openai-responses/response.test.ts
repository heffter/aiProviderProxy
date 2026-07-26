/**
 * Unit tests for non-streaming Responses object construction (AIPP-7, 7.2).
 */

import { describe, it, expect } from 'vitest';
import {
  buildResponsesObject,
  renderResponsesUsage,
  type CanonicalResponseResult,
} from '../../../src/protocols/openai-responses/response.js';

/** A deterministic id generator: r1, r2, ... so golden objects are stable. */
function seqIdGen(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id${n}`;
  };
}

const fixedNow = (): number => 1_700_000_000_000;

describe('renderResponsesUsage', () => {
  it('maps canonical usage including cached and reasoning details', () => {
    expect(
      renderResponsesUsage({
        inputTokens: 100,
        outputTokens: 40,
        cachedInputTokens: 25,
        reasoningTokens: 12,
      }),
    ).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 25 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 12 },
      total_tokens: 140,
    });
  });

  it('defaults cached and reasoning detail counters to zero', () => {
    expect(
      renderResponsesUsage({ inputTokens: 5, outputTokens: 3 }),
    ).toMatchObject({
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 8,
    });
  });
});

describe('buildResponsesObject — text', () => {
  it('renders a completed text response as a golden object', () => {
    const result: CanonicalResponseResult = {
      id: 'resp_abc',
      model: 'gpt-5-codex',
      status: 'completed',
      outputs: [{ kind: 'message', text: 'Hello there.' }],
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cachedInputTokens: 8,
        reasoningTokens: 0,
      },
    };
    const obj = buildResponsesObject(result, {
      genId: seqIdGen(),
      now: fixedNow,
    });
    expect(obj).toEqual({
      id: 'resp_abc',
      object: 'response',
      created_at: 1_700_000_000,
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model: 'gpt-5-codex',
      output: [
        {
          type: 'message',
          id: 'msg_id1',
          status: 'completed',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Hello there.', annotations: [] },
          ],
        },
      ],
      output_text: 'Hello there.',
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      reasoning: { effort: null, summary: null },
      metadata: {},
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 16,
      },
    });
  });

  it('mints a resp_ id and created_at from the clock when absent', () => {
    const obj = buildResponsesObject(
      { model: 'm', status: 'completed', outputs: [] },
      { genId: seqIdGen(), now: fixedNow },
    );
    expect(obj.id).toBe('resp_id1');
    expect(obj.created_at).toBe(1_700_000_000);
    expect(obj.output_text).toBe('');
  });

  it('echoes request-derived fields when supplied', () => {
    const obj = buildResponsesObject(
      { model: 'm', status: 'completed', outputs: [] },
      {
        genId: seqIdGen(),
        now: fixedNow,
        echo: {
          instructions: 'be terse',
          maxOutputTokens: 256,
          metadata: { s: '1' },
          parallelToolCalls: false,
          temperature: 0.5,
          topP: 0.8,
          toolChoice: 'required',
          tools: [{ type: 'function', name: 'f' }],
          reasoning: { effort: 'high', summary: null },
        },
      },
    );
    expect(obj).toMatchObject({
      instructions: 'be terse',
      max_output_tokens: 256,
      metadata: { s: '1' },
      parallel_tool_calls: false,
      temperature: 0.5,
      top_p: 0.8,
      tool_choice: 'required',
      tools: [{ type: 'function', name: 'f' }],
      reasoning: { effort: 'high', summary: null },
    });
  });
});

describe('buildResponsesObject — tool call', () => {
  it('renders a function_call output item and aggregates output_text', () => {
    const result: CanonicalResponseResult = {
      id: 'resp_1',
      model: 'gpt-5-codex',
      status: 'completed',
      outputs: [
        { kind: 'message', text: 'Calling a tool. ' },
        {
          kind: 'function_call',
          callId: 'call_42',
          name: 'get_weather',
          arguments: '{"city":"SF"}',
        },
      ],
      usage: { inputTokens: 20, outputTokens: 10 },
    };
    const obj = buildResponsesObject(result, {
      genId: seqIdGen(),
      now: fixedNow,
    });
    expect(obj.output).toEqual([
      {
        type: 'message',
        id: 'msg_id1',
        status: 'completed',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Calling a tool. ', annotations: [] },
        ],
      },
      {
        type: 'function_call',
        id: 'fc_id2',
        status: 'completed',
        call_id: 'call_42',
        name: 'get_weather',
        arguments: '{"city":"SF"}',
      },
    ]);
    expect(obj.output_text).toBe('Calling a tool. ');
  });
});

describe('buildResponsesObject — incomplete and failed', () => {
  it('sets incomplete_details.reason for an incomplete result', () => {
    const obj = buildResponsesObject(
      {
        model: 'm',
        status: 'incomplete',
        incompleteReason: 'max_output_tokens',
        outputs: [{ kind: 'message', text: 'partial' }],
        usage: { inputTokens: 5, outputTokens: 256 },
      },
      { genId: seqIdGen(), now: fixedNow },
    );
    expect(obj.status).toBe('incomplete');
    expect(obj.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    expect(obj.error).toBeNull();
  });

  it('defaults the incomplete reason to max_output_tokens', () => {
    const obj = buildResponsesObject(
      { model: 'm', status: 'incomplete', outputs: [] },
      { genId: seqIdGen(), now: fixedNow },
    );
    expect(obj.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('renders a failed result with a top-level error object and no usage', () => {
    const obj = buildResponsesObject(
      {
        model: 'm',
        status: 'failed',
        error: { code: 'server_error', message: 'upstream exploded' },
        outputs: [],
      },
      { genId: seqIdGen(), now: fixedNow },
    );
    expect(obj.status).toBe('failed');
    expect(obj.error).toEqual({
      code: 'server_error',
      message: 'upstream exploded',
    });
    expect(obj.incomplete_details).toBeNull();
    expect(obj.usage).toBeUndefined();
  });
});
