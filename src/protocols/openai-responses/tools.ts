/**
 * OpenAI Responses tool mapping and hosted-tool policy (epic AIPP-7, subtask
 * 7.4; FR-RESP-006/011/012, FR-TOOLS-001..005/008/009).
 *
 * Three concerns for tools on the Responses surface:
 *
 *   1. Function tools -- map a Responses function tool (flat `{ type, name,
 *      description, parameters }`) to the Chat Completions nested shape, and map
 *      `tool_choice` between the two surfaces, so a Responses request can be
 *      served by a chat-protocol upstream (subtask 7.5). Call ids are preserved
 *      verbatim through translation (FR-TOOLS-002).
 *   2. Hosted (provider-executed) tools -- web_search, file_search,
 *      code_interpreter, computer_use and variants. The gateway never emulates
 *      these; it passes them through only to an OpenAI upstream that actually
 *      runs them and only when each is explicitly configured as allowed.
 *      Otherwise it returns a structured capability error (FR-RESP-011/012).
 *   3. Parallel tool calls -- forwarded only when the routed model declares the
 *      capability (FR-TOOLS-004).
 *
 * Deny-by-default tool-router authorization (the tool packs) is enforced by the
 * shared module from AIPP-6 (`src/tools`); this module supplies the requested
 * function-tool names and the strip helper the route handler uses.
 */

import { capabilityError, type ResponsesErrorEnvelope } from './errors.js';
import type {
  ParsedResponsesRequest,
  ResponsesFunctionTool,
  ResponsesHostedTool,
} from './request.js';

/** A Chat Completions function tool (nested shape). */
export interface ChatFunctionTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

/** Map a Responses function tool to the Chat Completions nested shape. */
export function responsesFunctionToolToChat(
  tool: ResponsesFunctionTool,
): ChatFunctionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description !== undefined
        ? { description: tool.description }
        : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    },
  };
}

/** Map every Responses function tool to the Chat tools array. */
export function responsesFunctionToolsToChat(
  tools: ResponsesFunctionTool[],
): ChatFunctionTool[] {
  return tools.map(responsesFunctionToolToChat);
}

/**
 * Map a Responses `tool_choice` to the Chat Completions equivalent. Returns
 * `undefined` for choices with no Chat representation (e.g. selecting a hosted
 * tool), which the caller omits rather than mistranslating.
 */
export function responsesToolChoiceToChat(choice: unknown): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') {
    return choice;
  }
  if (choice !== null && typeof choice === 'object') {
    const c = choice as { type?: unknown; name?: unknown };
    if (c.type === 'function' && typeof c.name === 'string') {
      return { type: 'function', function: { name: c.name } };
    }
  }
  return undefined;
}

/** A hosted-tool policy decision. */
export type HostedToolDecision =
  | { action: 'passthrough'; tools: ResponsesHostedTool[] }
  | { action: 'reject'; status: number; error: ResponsesErrorEnvelope };

/** Inputs to {@link decideHostedTools}. */
export interface HostedToolPolicy {
  /** Canonical id of the provider the request is routed to. */
  upstreamProvider: string;
  /** Hosted-tool types explicitly configured as allowed to pass through. */
  allowedHostedTools?: readonly string[];
}

/**
 * Decide whether the requested hosted tools may be forwarded. Pass through only
 * when the routed upstream is OpenAI itself and every requested hosted tool is
 * configured as allowed; otherwise reject with a capability error naming the
 * offending tools. The gateway never fakes hosted tools, so a single
 * unsatisfiable hosted tool rejects the whole request.
 */
export function decideHostedTools(
  hostedTools: ResponsesHostedTool[],
  policy: HostedToolPolicy,
): HostedToolDecision {
  if (hostedTools.length === 0) {
    return { action: 'passthrough', tools: [] };
  }
  if (policy.upstreamProvider !== 'openai') {
    return {
      action: 'reject',
      status: 400,
      error: capabilityError(
        `Hosted tools (${hostedTools
          .map((t) => t.type)
          .join(', ')}) require a direct OpenAI upstream that executes them; ` +
          `this request is routed to "${policy.upstreamProvider}". The gateway ` +
          'never emulates hosted tools.',
        { param: 'tools', code: 'hosted_tool_unsupported' },
      ),
    };
  }
  const allowed = new Set(policy.allowedHostedTools ?? []);
  const disallowed = hostedTools.filter((t) => !allowed.has(t.type));
  if (disallowed.length > 0) {
    return {
      action: 'reject',
      status: 400,
      error: capabilityError(
        `Hosted tools (${disallowed
          .map((t) => t.type)
          .join(', ')}) are not enabled for pass-through. Add them to the ` +
          'allowed hosted-tools configuration to permit them.',
        { param: 'tools', code: 'hosted_tool_not_allowed' },
      ),
    };
  }
  return { action: 'passthrough', tools: hostedTools };
}

/**
 * Gate `parallel_tool_calls` on the routed model's capability. Returns the
 * effective value to forward: the request value when the model is capable,
 * `false` when it is not (forcing sequential calls), or `undefined` when the
 * client did not ask (leave it to the upstream default).
 */
export function gateParallelToolCalls(
  requested: boolean | undefined,
  capable: boolean,
): boolean | undefined {
  if (requested === undefined) {
    return undefined;
  }
  return capable ? requested : false;
}

/** The function-tool names to evaluate against the tool-router policy. */
export function responsesRequestedToolNames(
  request: ParsedResponsesRequest,
): string[] {
  return request.functionTools.map((t) => t.name).filter((n) => n.length > 0);
}

/**
 * Drop denied function tools from a parsed request (both the typed
 * `functionTools` and the raw `tools` array) so the model cannot call them even
 * when only a subset was denied. Hosted tools are governed separately by
 * {@link decideHostedTools} and are left untouched here.
 */
export function stripDeniedFunctionTools(
  request: ParsedResponsesRequest,
  allowed: Set<string>,
): void {
  request.functionTools = request.functionTools.filter((t) =>
    allowed.has(t.name),
  );
  const rawTools = (request.raw as { tools?: unknown }).tools;
  if (Array.isArray(rawTools)) {
    (request.raw as { tools: unknown[] }).tools = rawTools.filter((tool) => {
      const t = tool as { type?: unknown; name?: unknown };
      // Keep hosted tools and any non-function entries; filter function tools by
      // the allowed set.
      if (t.type !== 'function') {
        return true;
      }
      return typeof t.name === 'string' && allowed.has(t.name);
    });
  }
}
