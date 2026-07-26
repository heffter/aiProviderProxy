/**
 * OpenAI Responses non-streaming object construction (epic AIPP-7, subtask 7.2;
 * FR-RESP-002/003/009/013/014).
 *
 * Renders a provider-neutral *canonical result* as a spec-valid non-streaming
 * Responses object: the top-level `response` envelope, its `output` array of
 * message and function-call items, the `output_text` convenience aggregation,
 * and a fully-populated `usage` block (input/output tokens with cached-input and
 * reasoning-token details). The canonical result is upstream-agnostic: it can be
 * built from an OpenAI Responses upstream (near-verbatim) or reconstructed from a
 * Chat Completions upstream (subtask 7.5). This module owns only the client-wire
 * rendering.
 */

import { uuidGen, type IdGen } from '../../lifecycle/index.js';

/** Terminal status of a canonical result. */
export type ResponseStatus = 'completed' | 'failed' | 'incomplete';

/** One provider-neutral output produced by the model. */
export type CanonicalOutput =
  | { kind: 'message'; text: string }
  | {
      kind: 'function_call';
      callId: string;
      name: string;
      arguments: string;
    };

/** Token usage in canonical shape (input/output with cached + reasoning detail). */
export interface CanonicalResponseUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cached input tokens (Responses `input_tokens_details.cached_tokens`). */
  cachedInputTokens?: number;
  /** Reasoning tokens (`output_tokens_details.reasoning_tokens`). */
  reasoningTokens?: number;
}

/** A provider-neutral, upstream-agnostic result to render as a Responses object. */
export interface CanonicalResponseResult {
  /** Provider response id, when the upstream supplied one. */
  id?: string;
  model: string;
  status: ResponseStatus;
  /**
   * Why an `incomplete` result stopped early, e.g. `max_output_tokens` or
   * `content_filter`. Ignored unless status is `incomplete`.
   */
  incompleteReason?: string;
  /** Error detail for a `failed` result. Ignored otherwise. */
  error?: { code?: string; message: string };
  outputs: CanonicalOutput[];
  usage?: CanonicalResponseUsage;
  /** Creation time in epoch seconds; defaults to now. */
  createdAt?: number;
}

/**
 * Request-derived fields echoed back onto the response object (Responses echoes
 * the request parameters). All optional; absent fields are rendered as the
 * Responses defaults (`null` for scalars, `[]`/`{}` where the API uses those).
 */
export interface ResponsesEcho {
  instructions?: string | null;
  maxOutputTokens?: number | null;
  metadata?: Record<string, unknown>;
  parallelToolCalls?: boolean;
  temperature?: number | null;
  topP?: number | null;
  toolChoice?: unknown;
  tools?: unknown[];
  /** Reasoning echo, e.g. `{ effort, summary }`. */
  reasoning?: Record<string, unknown>;
}

/** Dependencies for {@link buildResponsesObject}. */
export interface ResponsesBuildDeps {
  /** Item-id generator; defaults to a UUID-backed generator. */
  genId?: IdGen;
  /** Epoch-millis clock; `created_at` is `floor(now/1000)`. Defaults to Date.now. */
  now?: () => number;
  /** Request-derived fields echoed onto the response object. */
  echo?: ResponsesEcho;
}

/** A rendered Responses output item. */
type ResponsesOutputItem = Record<string, unknown>;

function prefixedId(genId: IdGen, prefix: string): string {
  return `${prefix}_${genId().replace(/-/g, '')}`;
}

/** Render the canonical `usage` block into the Responses usage shape. */
export function renderResponsesUsage(
  usage: CanonicalResponseUsage,
): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

/** Render one canonical output into its Responses output item. */
function renderOutputItem(
  output: CanonicalOutput,
  genId: IdGen,
): ResponsesOutputItem {
  if (output.kind === 'message') {
    return {
      type: 'message',
      id: prefixedId(genId, 'msg'),
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: output.text,
          annotations: [],
        },
      ],
    };
  }
  return {
    type: 'function_call',
    id: prefixedId(genId, 'fc'),
    status: 'completed',
    call_id: output.callId,
    name: output.name,
    arguments: output.arguments,
  };
}

/**
 * Build a spec-valid non-streaming Responses object from a canonical result.
 */
export function buildResponsesObject(
  result: CanonicalResponseResult,
  deps: ResponsesBuildDeps = {},
): Record<string, unknown> {
  const genId = deps.genId ?? uuidGen;
  const nowMs = deps.now ? deps.now() : Date.now();
  const createdAt = result.createdAt ?? Math.floor(nowMs / 1000);
  const echo = deps.echo ?? {};

  const output = result.outputs.map((o) => renderOutputItem(o, genId));

  // output_text: convenience aggregation of every message item's text.
  const outputText = result.outputs
    .filter(
      (o): o is Extract<CanonicalOutput, { kind: 'message' }> =>
        o.kind === 'message',
    )
    .map((o) => o.text)
    .join('');

  const obj: Record<string, unknown> = {
    id: result.id ?? prefixedId(genId, 'resp'),
    object: 'response',
    created_at: createdAt,
    status: result.status,
    error:
      result.status === 'failed'
        ? {
            code: result.error?.code ?? 'server_error',
            message: result.error?.message ?? 'Response failed',
          }
        : null,
    incomplete_details:
      result.status === 'incomplete'
        ? { reason: result.incompleteReason ?? 'max_output_tokens' }
        : null,
    instructions: echo.instructions ?? null,
    max_output_tokens: echo.maxOutputTokens ?? null,
    model: result.model,
    output,
    output_text: outputText,
    parallel_tool_calls: echo.parallelToolCalls ?? true,
    temperature: echo.temperature ?? null,
    tool_choice: echo.toolChoice ?? 'auto',
    tools: echo.tools ?? [],
    top_p: echo.topP ?? null,
    reasoning: echo.reasoning ?? { effort: null, summary: null },
    metadata: echo.metadata ?? {},
  };

  if (result.usage) {
    obj.usage = renderResponsesUsage(result.usage);
  }

  return obj;
}
