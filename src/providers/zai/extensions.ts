/**
 * Z.ai GLM protocol extensions (epic AIPP-9, subtask 9.1; FR-PA-ZAI-001..004,
 * FR-PROV-010).
 *
 * GLM speaks Chat Completions with a few typed extensions the generic adapter
 * does not model:
 *
 *   - request: a `thinking` object (`{ type: 'enabled' | 'disabled' }`), a
 *     `reasoning_effort` string, and a `tool_stream` boolean.
 *   - response: `reasoning_content` (the model's reasoning text, per choice) and
 *     GLM-specific usage counters.
 *
 * These are read/validated here so the adapter and the cross-protocol reasoning
 * mapping (subtask 9.3) can pass them through and namespace them under
 * `extra.zai` without the rest of the gateway needing GLM knowledge. Reasoning
 * text is client-facing content (mapped to thinking blocks / reasoning
 * summaries); it is never exported to telemetry.
 *
 * Shapes verified against the Z.ai GLM Chat Completions API (thinking control,
 * reasoning_content, tool_stream) as of 2026-07.
 */

/** GLM `thinking` control object. */
export interface GlmThinking {
  type: 'enabled' | 'disabled';
}

/** Typed GLM request extension fields. */
export interface GlmRequestExtensions {
  thinking?: GlmThinking;
  reasoning_effort?: string;
  tool_stream?: boolean;
}

/** GLM response extras captured for mapping and namespaced telemetry. */
export interface GlmResponseExtras {
  /** Provider request id (response header or body id). */
  requestId?: string;
  /** Reasoning text from the first choice, when present (client-facing only). */
  reasoningContent?: string;
  /** GLM-specific numeric usage counters, namespaced under `zai.*`. */
  usageExtras: Record<string, number>;
}

/** Standard OpenAI usage keys; anything else GLM sends is namespaced. */
const STANDARD_USAGE_KEYS: ReadonlySet<string> = new Set([
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'prompt_tokens_details',
  'completion_tokens_details',
]);

/** Extract and validate the typed GLM request extensions from a chat body. */
export function extractGlmRequestExtensions(
  body: unknown,
): GlmRequestExtensions {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const b = body as {
    thinking?: unknown;
    reasoning_effort?: unknown;
    tool_stream?: unknown;
  };
  const out: GlmRequestExtensions = {};
  if (
    b.thinking &&
    typeof b.thinking === 'object' &&
    ((b.thinking as { type?: unknown }).type === 'enabled' ||
      (b.thinking as { type?: unknown }).type === 'disabled')
  ) {
    out.thinking = { type: (b.thinking as GlmThinking).type };
  }
  if (typeof b.reasoning_effort === 'string') {
    out.reasoning_effort = b.reasoning_effort;
  }
  if (typeof b.tool_stream === 'boolean') {
    out.tool_stream = b.tool_stream;
  }
  return out;
}

/** Namespace GLM-specific numeric usage counters under `zai.*`. */
export function extractGlmUsageExtras(usage: unknown): Record<string, number> {
  const extras: Record<string, number> = {};
  if (!usage || typeof usage !== 'object') {
    return extras;
  }
  for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
    if (!STANDARD_USAGE_KEYS.has(key) && typeof value === 'number') {
      extras[`zai.${key}`] = value;
    }
  }
  return extras;
}

/** Read the reasoning text from the first choice (message or delta). */
export function extractGlmReasoningContent(body: unknown): string | undefined {
  const choice = (body as { choices?: Array<Record<string, unknown>> })
    ?.choices?.[0];
  if (!choice) {
    return undefined;
  }
  const fromMessage = (choice.message as { reasoning_content?: unknown })
    ?.reasoning_content;
  if (typeof fromMessage === 'string' && fromMessage.length > 0) {
    return fromMessage;
  }
  const fromDelta = (choice.delta as { reasoning_content?: unknown })
    ?.reasoning_content;
  if (typeof fromDelta === 'string' && fromDelta.length > 0) {
    return fromDelta;
  }
  return undefined;
}

/** Capture the GLM response extras from a parsed body and headers. */
export function extractGlmResponseExtras(
  body: unknown,
  requestId: string | undefined,
): GlmResponseExtras {
  return {
    requestId: requestId ?? (body as { id?: string })?.id,
    reasoningContent: extractGlmReasoningContent(body),
    usageExtras: extractGlmUsageExtras((body as { usage?: unknown })?.usage),
  };
}
