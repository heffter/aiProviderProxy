/**
 * Cross-protocol reasoning mapping for GLM (epic AIPP-9, subtask 9.3;
 * FR-PA-ZAI-005/006, resolves OQ-002 for GLM).
 *
 * GLM exposes reasoning as a `thinking` request control (plus `reasoning_effort`)
 * and a `reasoning_content` response field. This module maps that to and from
 * the client protocols:
 *
 *   - request: Anthropic `thinking` (budget) and Responses `reasoning.effort`
 *     both map to GLM `thinking` + `reasoning_effort`.
 *   - response: GLM `reasoning_content` maps to an Anthropic `thinking` block or
 *     a Responses reasoning summary where representable. Signatures are NEVER
 *     fabricated; when a target cannot represent the reasoning it is dropped with
 *     a namespaced diagnostic (never silently).
 *
 * The `tool_stream` control is capability-gated: it is only forwarded when the
 * routed model supports streamed tool calls.
 */

import type { GlmThinking } from './extensions.js';

/** GLM reasoning request controls to merge into a chat body. */
export interface GlmReasoningControls {
  thinking?: GlmThinking;
  reasoning_effort?: string;
  tool_stream?: boolean;
}

/** A namespaced diagnostic for reasoning that could not be represented. */
export interface ReasoningDiagnostic {
  namespace: 'zai.reasoning';
  kind: string;
  count: number;
}

/**
 * Map an Anthropic `thinking` request control to GLM reasoning controls. The
 * Anthropic budget is bucketed into a GLM `reasoning_effort` band; `disabled`
 * (or absent) yields no controls.
 */
export function anthropicThinkingToGlm(
  thinking: unknown,
): GlmReasoningControls {
  if (!thinking || typeof thinking !== 'object') {
    return {};
  }
  const t = thinking as { type?: unknown; budget_tokens?: unknown };
  if (t.type !== 'enabled') {
    return {};
  }
  const controls: GlmReasoningControls = { thinking: { type: 'enabled' } };
  if (typeof t.budget_tokens === 'number') {
    controls.reasoning_effort = effortForBudget(t.budget_tokens);
  }
  return controls;
}

/** Bucket an Anthropic thinking budget (tokens) into a GLM reasoning effort. */
export function effortForBudget(budgetTokens: number): string {
  if (budgetTokens < 4_000) return 'low';
  if (budgetTokens < 16_000) return 'medium';
  return 'high';
}

/** Map a Responses `reasoning.effort` to GLM reasoning controls. */
export function responsesEffortToGlm(
  effort: string | undefined,
): GlmReasoningControls {
  if (effort === undefined) {
    return {};
  }
  return { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

/**
 * Map GLM reasoning text to an Anthropic `thinking` content block. No signature
 * is attached -- Anthropic thinking blocks from a translated upstream are
 * unsigned, and the gateway never fabricates one.
 */
export function glmReasoningToAnthropicBlock(
  reasoningContent: string | undefined,
): { type: 'thinking'; thinking: string } | null {
  if (!reasoningContent || reasoningContent.length === 0) {
    return null;
  }
  return { type: 'thinking', thinking: reasoningContent };
}

/**
 * Map GLM reasoning text to a Responses reasoning summary part. Surfaced only
 * when the upstream actually provided reasoning text.
 */
export function glmReasoningToResponsesSummary(
  reasoningContent: string | undefined,
): { type: 'summary_text'; text: string } | null {
  if (!reasoningContent || reasoningContent.length === 0) {
    return null;
  }
  return { type: 'summary_text', text: reasoningContent };
}

/** A namespaced diagnostic recording that reasoning could not be represented. */
export function reasoningDiagnostic(kind: string): ReasoningDiagnostic {
  return { namespace: 'zai.reasoning', kind, count: 1 };
}

/**
 * Gate the GLM `tool_stream` control on the routed model's streamed-tool-call
 * capability. Returns the value to forward, or `undefined` to omit it.
 */
export function gateToolStream(
  requested: boolean | undefined,
  capable: boolean,
): boolean | undefined {
  if (requested === undefined) {
    return undefined;
  }
  return capable ? requested : false;
}
