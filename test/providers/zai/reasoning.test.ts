/**
 * Unit tests for GLM cross-protocol reasoning mapping (AIPP-9, 9.3).
 */

import { describe, it, expect } from 'vitest';
import {
  anthropicThinkingToGlm,
  effortForBudget,
  responsesEffortToGlm,
  glmReasoningToAnthropicBlock,
  glmReasoningToResponsesSummary,
  reasoningDiagnostic,
  gateToolStream,
} from '../../../src/providers/zai/reasoning.js';

describe('request-direction mapping', () => {
  it('maps an Anthropic thinking budget to GLM thinking + effort band', () => {
    expect(
      anthropicThinkingToGlm({ type: 'enabled', budget_tokens: 2_000 }),
    ).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' });
    expect(
      anthropicThinkingToGlm({ type: 'enabled', budget_tokens: 10_000 }),
    ).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'medium' });
    expect(
      anthropicThinkingToGlm({ type: 'enabled', budget_tokens: 30_000 }),
    ).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });

  it('buckets budgets into effort bands', () => {
    expect(effortForBudget(0)).toBe('low');
    expect(effortForBudget(3_999)).toBe('low');
    expect(effortForBudget(4_000)).toBe('medium');
    expect(effortForBudget(16_000)).toBe('high');
  });

  it('yields no controls when thinking is disabled or absent', () => {
    expect(anthropicThinkingToGlm({ type: 'disabled' })).toEqual({});
    expect(anthropicThinkingToGlm(undefined)).toEqual({});
  });

  it('maps a Responses reasoning effort to GLM controls', () => {
    expect(responsesEffortToGlm('high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(responsesEffortToGlm(undefined)).toEqual({});
  });
});

describe('response-direction mapping', () => {
  it('maps GLM reasoning to an unsigned Anthropic thinking block', () => {
    const block = glmReasoningToAnthropicBlock('let me think');
    expect(block).toEqual({ type: 'thinking', thinking: 'let me think' });
    // No signature is ever fabricated.
    expect(block && 'signature' in block).toBe(false);
  });

  it('maps GLM reasoning to a Responses reasoning summary', () => {
    expect(glmReasoningToResponsesSummary('because')).toEqual({
      type: 'summary_text',
      text: 'because',
    });
  });

  it('returns null (no fabricated reasoning) when there is none', () => {
    expect(glmReasoningToAnthropicBlock(undefined)).toBeNull();
    expect(glmReasoningToAnthropicBlock('')).toBeNull();
    expect(glmReasoningToResponsesSummary(undefined)).toBeNull();
  });

  it('builds a namespaced reasoning diagnostic', () => {
    expect(reasoningDiagnostic('unrepresentable')).toEqual({
      namespace: 'zai.reasoning',
      kind: 'unrepresentable',
      count: 1,
    });
  });
});

describe('tool_stream capability gate', () => {
  it('forwards when capable, forces off when not, omits when unasked', () => {
    expect(gateToolStream(true, true)).toBe(true);
    expect(gateToolStream(true, false)).toBe(false);
    expect(gateToolStream(false, true)).toBe(false);
    expect(gateToolStream(undefined, true)).toBeUndefined();
  });
});
