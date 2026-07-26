/**
 * OpenAI Chat <-> Ollama /api/chat translation (epic AIPP-8, subtask 8.4;
 * FR-PA-OLL-001, FR-TOOLS-001..004). Ported from the legacy src/ollama.ts.
 *
 * Ollama's chat API is close to OpenAI's (messages carry a role and content),
 * so translation is light: sampling controls move under `options`, tool-call
 * arguments cross the object/string boundary (Ollama uses an object; Chat uses a
 * JSON string), and usage comes from `prompt_eval_count` / `eval_count`. The
 * NDJSON stream (one JSON object per line) is translated to
 * `chat.completion.chunk` records.
 */

/** An Ollama /api/chat request body (subset produced by translation). */
export interface OllamaRequestBody {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: { num_predict?: number; temperature?: number; top_p?: number };
  tools?: unknown[];
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  tool_call_id?: string;
}

interface ChatMessageLike {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type?: string; text?: string } =>
          p !== null && typeof p === 'object',
      )
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
  }
  return '';
}

/** Translate an OpenAI chat body into an Ollama /api/chat body. */
export function chatToOllamaRequest(body: unknown): OllamaRequestBody {
  const b = (body ?? {}) as {
    model?: string;
    messages?: ChatMessageLike[];
    tools?: unknown[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
  };
  const messages: OllamaMessage[] = (b.messages ?? []).map((message) => {
    const out: OllamaMessage = {
      role: message.role,
      content: textOf(message.content),
    };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      out.tool_calls = message.tool_calls.map((call) => {
        let args: unknown = {};
        try {
          args = JSON.parse(call.function?.arguments ?? '{}');
        } catch {
          args = {};
        }
        return {
          function: {
            name: String(call.function?.name ?? ''),
            arguments: args,
          },
        };
      });
    }
    if (typeof message.tool_call_id === 'string') {
      out.tool_call_id = message.tool_call_id;
    }
    return out;
  });

  const request: OllamaRequestBody = {
    model: String(b.model ?? ''),
    messages,
    stream: b.stream === true,
  };
  const options: NonNullable<OllamaRequestBody['options']> = {};
  if (typeof b.max_tokens === 'number') options.num_predict = b.max_tokens;
  if (typeof b.temperature === 'number') options.temperature = b.temperature;
  if (typeof b.top_p === 'number') options.top_p = b.top_p;
  if (Object.keys(options).length > 0) request.options = options;
  if (Array.isArray(b.tools) && b.tools.length > 0) request.tools = b.tools;
  return request;
}

/** Map an Ollama done_reason to a chat finish_reason. */
export function ollamaFinishToChat(reason: string | undefined): string {
  return reason === 'length' ? 'length' : 'stop';
}

/** Extract chat usage from Ollama eval counters. */
export function ollamaUsage(body: unknown):
  | {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    }
  | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { prompt_eval_count?: number; eval_count?: number };
  if (b.prompt_eval_count === undefined && b.eval_count === undefined) {
    return undefined;
  }
  const prompt = b.prompt_eval_count ?? 0;
  const completion = b.eval_count ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/** Translate an Ollama message's tool_calls into chat tool_calls. */
function ollamaToolCalls(
  toolCalls: unknown,
  idPrefix: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call, i) => {
    const c = call as { function?: { name?: string; arguments?: unknown } };
    const args = c.function?.arguments;
    return {
      id: `${idPrefix}_${i}`,
      type: 'function',
      function: {
        name: String(c.function?.name ?? ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    };
  });
}

/** Translate an Ollama /api/chat response into a chat.completion object. */
export function ollamaResponseToChat(
  body: unknown,
  model: string,
  id: string,
  created: number,
): Record<string, unknown> {
  const b = (body ?? {}) as {
    message?: { content?: string; tool_calls?: unknown };
    done_reason?: string;
  };
  const toolCalls = ollamaToolCalls(b.message?.tool_calls, id);
  const message: Record<string, unknown> = { role: 'assistant' };
  const content = b.message?.content ?? '';
  if (toolCalls.length > 0) {
    message.content = content.length > 0 ? content : null;
    message.tool_calls = toolCalls;
  } else {
    message.content = content;
  }
  const finishReason =
    toolCalls.length > 0 ? 'tool_calls' : ollamaFinishToChat(b.done_reason);

  const obj: Record<string, unknown> = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  const usage = ollamaUsage(body);
  if (usage) obj.usage = usage;
  return obj;
}

/** Translate one NDJSON Ollama stream line into a chat.completion.chunk data. */
export function ollamaChunkToChat(
  line: string,
): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const p = parsed as {
    message?: { content?: string };
    done?: boolean;
    done_reason?: string;
  };
  const content = p.message?.content ?? '';
  return {
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: content.length > 0 ? { content } : {},
        finish_reason: p.done ? ollamaFinishToChat(p.done_reason) : null,
      },
    ],
  };
}
