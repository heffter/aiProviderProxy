/**
 * Unit tests for Responses tool mapping and hosted-tool policy (AIPP-7, 7.4).
 */

import { describe, it, expect } from 'vitest';
import { parseResponsesRequest } from '../../../src/protocols/openai-responses/request.js';
import {
  responsesFunctionToolToChat,
  responsesFunctionToolsToChat,
  responsesToolChoiceToChat,
  decideHostedTools,
  gateParallelToolCalls,
  responsesRequestedToolNames,
  stripDeniedFunctionTools,
} from '../../../src/protocols/openai-responses/tools.js';

function parse(body: Record<string, unknown>) {
  const res = parseResponsesRequest({ model: 'm', input: 'hi', ...body });
  if (!res.ok) {
    throw new Error(`unexpected parse failure: ${res.error.error.message}`);
  }
  return res.request;
}

describe('function tool mapping', () => {
  it('maps a Responses function tool to the Chat nested shape', () => {
    expect(
      responsesFunctionToolToChat({
        type: 'function',
        name: 'get_weather',
        description: 'weather',
        parameters: { type: 'object' },
        strict: true,
      }),
    ).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'weather',
        parameters: { type: 'object' },
      },
    });
  });

  it('omits absent description and parameters', () => {
    expect(
      responsesFunctionToolToChat({ type: 'function', name: 'f' }),
    ).toEqual({ type: 'function', function: { name: 'f' } });
  });

  it('maps a whole tools array', () => {
    const tools = responsesFunctionToolsToChat([
      { type: 'function', name: 'a' },
      { type: 'function', name: 'b' },
    ]);
    expect(tools.map((t) => t.function.name)).toEqual(['a', 'b']);
  });
});

describe('tool_choice mapping', () => {
  it('passes through auto / none / required', () => {
    expect(responsesToolChoiceToChat('auto')).toBe('auto');
    expect(responsesToolChoiceToChat('none')).toBe('none');
    expect(responsesToolChoiceToChat('required')).toBe('required');
  });

  it('maps a named function choice to the Chat nested shape', () => {
    expect(
      responsesToolChoiceToChat({ type: 'function', name: 'get_weather' }),
    ).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('returns undefined for a hosted-tool choice or unknown shape', () => {
    expect(responsesToolChoiceToChat({ type: 'web_search' })).toBeUndefined();
    expect(responsesToolChoiceToChat(42)).toBeUndefined();
  });
});

describe('hosted-tool policy', () => {
  const hosted = [{ type: 'web_search', raw: { type: 'web_search' } }];

  it('passes through when no hosted tools are requested', () => {
    const decision = decideHostedTools([], { upstreamProvider: 'zai' });
    expect(decision).toEqual({ action: 'passthrough', tools: [] });
  });

  it('rejects hosted tools on a non-OpenAI upstream', () => {
    const decision = decideHostedTools(hosted, { upstreamProvider: 'zai' });
    expect(decision.action).toBe('reject');
    if (decision.action === 'reject') {
      expect(decision.status).toBe(400);
      expect(decision.error.error.code).toBe('hosted_tool_unsupported');
      expect(decision.error.error.message).toMatch(/require a direct OpenAI/);
    }
  });

  it('rejects hosted tools on OpenAI when not configured as allowed', () => {
    const decision = decideHostedTools(hosted, {
      upstreamProvider: 'openai',
      allowedHostedTools: [],
    });
    expect(decision.action).toBe('reject');
    if (decision.action === 'reject') {
      expect(decision.error.error.code).toBe('hosted_tool_not_allowed');
    }
  });

  it('passes through hosted tools on OpenAI when every one is allowed', () => {
    const decision = decideHostedTools(hosted, {
      upstreamProvider: 'openai',
      allowedHostedTools: ['web_search'],
    });
    expect(decision).toEqual({ action: 'passthrough', tools: hosted });
  });

  it('rejects when any requested hosted tool is not allowed', () => {
    const decision = decideHostedTools(
      [
        { type: 'web_search', raw: {} },
        { type: 'code_interpreter', raw: {} },
      ],
      { upstreamProvider: 'openai', allowedHostedTools: ['web_search'] },
    );
    expect(decision.action).toBe('reject');
    if (decision.action === 'reject') {
      expect(decision.error.error.message).toMatch(/code_interpreter/);
      expect(decision.error.error.message).not.toMatch(/web_search\)/);
    }
  });
});

describe('parallel tool calls gating', () => {
  it('leaves the flag unset when the client did not ask', () => {
    expect(gateParallelToolCalls(undefined, true)).toBeUndefined();
    expect(gateParallelToolCalls(undefined, false)).toBeUndefined();
  });

  it('forwards the request value when the model is capable', () => {
    expect(gateParallelToolCalls(true, true)).toBe(true);
    expect(gateParallelToolCalls(false, true)).toBe(false);
  });

  it('forces sequential when the model is not capable', () => {
    expect(gateParallelToolCalls(true, false)).toBe(false);
  });
});

describe('authorization helpers', () => {
  it('extracts function tool names for the tool router', () => {
    const request = parse({
      tools: [
        { type: 'function', name: 'read_file' },
        { type: 'function', name: 'bash' },
        { type: 'web_search' },
      ],
    });
    expect(responsesRequestedToolNames(request)).toEqual(['read_file', 'bash']);
  });

  it('strips denied function tools from both typed and raw tools, keeping hosted', () => {
    const request = parse({
      tools: [
        { type: 'function', name: 'read_file' },
        { type: 'function', name: 'delete_file' },
        { type: 'web_search' },
      ],
    });
    stripDeniedFunctionTools(request, new Set(['read_file']));
    expect(request.functionTools.map((t) => t.name)).toEqual(['read_file']);
    const rawTools = (
      request.raw as { tools: Array<{ type: string; name?: string }> }
    ).tools;
    expect(rawTools).toEqual([
      { type: 'function', name: 'read_file' },
      { type: 'web_search' },
    ]);
  });
});
