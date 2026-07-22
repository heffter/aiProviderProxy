/**
 * Anthropic <-> OpenAI translation (epic AIPP-6, subtask 6.4; FR-ANTH, FR-TOOLS).
 *
 * The Messages surface accepts Anthropic requests and, when routed to an
 * OpenAI-style upstream, translates the request to Chat Completions and the
 * response back to an Anthropic message. Tools are mapped in both directions;
 * Anthropic thinking blocks and cache_control directives are dropped for OpenAI
 * upstreams (unsupported), which is recorded so the caller can surface it.
 */

import type {
  ContentBlock,
  MessageInput,
  ParsedMessagesRequest,
} from './messages-request.js';

/** An OpenAI Chat Completions request body (subset produced by translation). */
export interface OpenAIChatBody {
  model: string;
  messages: OpenAIMessage[];
  max_tokens: number;
  stream: boolean;
  temperature?: number;
  tools?: OpenAITool[];
  tool_choice?: unknown;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

/** Result of translating a request, with notes about dropped features. */
export interface TranslatedRequest {
  body: OpenAIChatBody;
  droppedThinking: boolean;
  droppedCacheControl: boolean;
}

function systemToText(system: unknown): string | undefined {
  if (typeof system === 'string') {
    return system;
  }
  if (Array.isArray(system)) {
    return system
      .filter((b): b is ContentBlock => b !== null && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  return undefined;
}

function hasCacheControl(blocks: ContentBlock[]): boolean {
  return blocks.some((b) => 'cache_control' in b);
}

function translateMessage(
  message: MessageInput,
  notes: { droppedThinking: boolean; droppedCacheControl: boolean },
): OpenAIMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }];
  }

  const blocks = message.content;
  if (hasCacheControl(blocks)) {
    notes.droppedCacheControl = true;
  }

  const parts: OpenAIContentPart[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  const toolMessages: OpenAIMessage[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text });
        }
        break;
      case 'image': {
        const source = block.source as
          { data?: string; media_type?: string } | undefined;
        if (source?.data) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${source.media_type ?? 'image/png'};base64,${source.data}`,
            },
          });
        }
        break;
      }
      case 'tool_use':
        toolCalls.push({
          id: String(block.id ?? ''),
          type: 'function',
          function: {
            name: String(block.name ?? ''),
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
        break;
      case 'tool_result':
        toolMessages.push({
          role: 'tool',
          tool_call_id: String(block.tool_use_id ?? ''),
          content:
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content ?? ''),
        });
        break;
      case 'thinking':
      case 'redacted_thinking':
        notes.droppedThinking = true;
        break;
      default:
        break;
    }
  }

  const out: OpenAIMessage[] = [];
  if (parts.length > 0 || toolCalls.length > 0) {
    const msg: OpenAIMessage = { role: message.role };
    if (parts.length > 0) {
      msg.content =
        parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
    }
    if (toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    out.push(msg);
  }
  out.push(...toolMessages);
  return out;
}

function translateTools(
  tools: unknown[] | undefined,
): OpenAITool[] | undefined {
  if (!tools) {
    return undefined;
  }
  return tools
    .filter(
      (t): t is Record<string, unknown> => t !== null && typeof t === 'object',
    )
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: String(t.name ?? ''),
        description:
          typeof t.description === 'string' ? t.description : undefined,
        parameters: t.input_schema,
      },
    }));
}

function translateToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') {
    return undefined;
  }
  const c = choice as { type?: string; name?: string };
  if (c.type === 'auto') {
    return 'auto';
  }
  if (c.type === 'any') {
    return 'required';
  }
  if (c.type === 'tool' && c.name) {
    return { type: 'function', function: { name: c.name } };
  }
  return undefined;
}

/** Translate an Anthropic Messages request to an OpenAI Chat Completions body. */
export function anthropicToOpenAIRequest(
  request: ParsedMessagesRequest,
  model: string,
): TranslatedRequest {
  const notes = { droppedThinking: false, droppedCacheControl: false };
  const messages: OpenAIMessage[] = [];

  if (
    Array.isArray(request.system) &&
    request.system.some(
      (b) => b !== null && typeof b === 'object' && 'cache_control' in b,
    )
  ) {
    notes.droppedCacheControl = true;
  }

  const systemText = systemToText(request.system);
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }
  for (const message of request.messages) {
    messages.push(...translateMessage(message, notes));
  }

  const raw = request.raw;
  const body: OpenAIChatBody = {
    model,
    messages,
    max_tokens: request.max_tokens,
    stream: request.stream,
    ...(typeof raw.temperature === 'number'
      ? { temperature: raw.temperature }
      : {}),
    ...(request.tools ? { tools: translateTools(request.tools) } : {}),
    ...(translateToolChoice(raw.tool_choice) !== undefined
      ? { tool_choice: translateToolChoice(raw.tool_choice) }
      : {}),
  };

  return {
    body,
    droppedThinking: notes.droppedThinking,
    droppedCacheControl: notes.droppedCacheControl,
  };
}

/** Map an OpenAI finish_reason to an Anthropic stop_reason. */
export function openAIFinishToAnthropicStop(
  finish: string | undefined,
): string {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'stop_sequence';
    case 'stop':
    default:
      return 'end_turn';
  }
}

/** An Anthropic message response (subset produced by translation). */
export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** Translate an OpenAI Chat Completions response into an Anthropic message. */
export function openAIResponseToAnthropic(
  response: unknown,
  model: string,
): AnthropicMessageResponse {
  const r = (response ?? {}) as {
    id?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = r.choices?.[0];
  const message = choice?.message;
  const content: ContentBlock[] = [];

  if (typeof message?.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content });
  }
  for (const call of message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input,
    });
  }

  return {
    id: r.id ?? '',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: openAIFinishToAnthropicStop(choice?.finish_reason),
    usage: {
      input_tokens: r.usage?.prompt_tokens ?? 0,
      output_tokens: r.usage?.completion_tokens ?? 0,
    },
  };
}
