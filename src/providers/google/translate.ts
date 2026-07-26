/**
 * OpenAI Chat <-> Google Gemini translation (epic AIPP-8, subtask 8.3;
 * FR-PA-GOO-001, FR-TOOLS-001..004).
 *
 * The Google adapter presents a Chat Completions interface to the gateway: it
 * accepts an OpenAI chat body, translates it to the Gemini `generateContent`
 * shape (contents, systemInstruction, tools as functionDeclarations,
 * generationConfig), and translates the Gemini response and stream chunks back
 * into `chat.completion` / `chat.completion.chunk` objects. Tool-call ids are
 * synthesized deterministically since Gemini does not carry them.
 */

/** A Gemini `generateContent` request body (subset produced by translation). */
export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: unknown } };

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface ChatMessageLike {
  role: string;
  content?: unknown;
  name?: string;
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

/** Map a chat `tools` array to Gemini functionDeclarations. */
function toolsToGemini(
  tools: unknown[] | undefined,
): Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  const decls = tools
    .filter(
      (t): t is { function?: Record<string, unknown> } =>
        t !== null && typeof t === 'object',
    )
    .map((t) => {
      const fn = t.function ?? {};
      return {
        name: String(fn.name ?? ''),
        ...(typeof fn.description === 'string'
          ? { description: fn.description }
          : {}),
        ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      };
    });
  return [{ functionDeclarations: decls }];
}

/** Translate an OpenAI chat body into a Gemini generateContent body. */
export function chatToGeminiRequest(body: unknown): GeminiRequestBody {
  const b = (body ?? {}) as {
    messages?: ChatMessageLike[];
    tools?: unknown[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
  };
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];
  for (const message of b.messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') {
      systemParts.push(textOf(message.content));
      continue;
    }
    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: String(message.name ?? message.tool_call_id ?? ''),
              response: { content: textOf(message.content) },
            },
          },
        ],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const parts: GeminiPart[] = [];
      const text = textOf(message.content);
      if (text.length > 0) {
        parts.push({ text });
      }
      for (const call of message.tool_calls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.function?.arguments ?? '{}');
        } catch {
          args = {};
        }
        parts.push({
          functionCall: { name: String(call.function?.name ?? ''), args },
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    // user (and any other) -> user text.
    contents.push({ role: 'user', parts: [{ text: textOf(message.content) }] });
  }

  const request: GeminiRequestBody = { contents };
  if (systemParts.length > 0) {
    request.systemInstruction = { parts: [{ text: systemParts.join('\n') }] };
  }
  const tools = toolsToGemini(b.tools);
  if (tools) {
    request.tools = tools;
  }
  const generationConfig: GeminiRequestBody['generationConfig'] = {};
  if (typeof b.max_tokens === 'number') {
    generationConfig.maxOutputTokens = b.max_tokens;
  }
  if (typeof b.temperature === 'number') {
    generationConfig.temperature = b.temperature;
  }
  if (typeof b.top_p === 'number') {
    generationConfig.topP = b.top_p;
  }
  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig;
  }
  return request;
}

/** Map a Gemini finishReason to a chat finish_reason. */
export function geminiFinishToChat(reason: string | undefined): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** Extract chat usage from Gemini usageMetadata. */
export function geminiUsage(metadata: unknown):
  | {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_tokens_details?: { cached_tokens: number };
    }
  | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const m = metadata as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  const prompt = m.promptTokenCount ?? 0;
  const completion = m.candidatesTokenCount ?? 0;
  const usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens: number };
  } = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: m.totalTokenCount ?? prompt + completion,
  };
  if (m.cachedContentTokenCount !== undefined) {
    usage.prompt_tokens_details = { cached_tokens: m.cachedContentTokenCount };
  }
  return usage;
}

/** Extract text and tool calls from a Gemini candidate's parts. */
function partsToChat(
  parts: unknown,
  toolIdPrefix: string,
): { text: string; toolCalls: Array<Record<string, unknown>> } {
  let text = '';
  const toolCalls: Array<Record<string, unknown>> = [];
  if (Array.isArray(parts)) {
    parts.forEach((part, i) => {
      const p = part as {
        text?: string;
        functionCall?: { name?: string; args?: unknown };
      };
      if (typeof p.text === 'string') {
        text += p.text;
      } else if (p.functionCall) {
        toolCalls.push({
          id: `${toolIdPrefix}_${i}`,
          type: 'function',
          function: {
            name: String(p.functionCall.name ?? ''),
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
        });
      }
    });
  }
  return { text, toolCalls };
}

/** Translate a Gemini generateContent response into a chat.completion object. */
export function geminiResponseToChat(
  body: unknown,
  model: string,
  id: string,
  created: number,
): Record<string, unknown> {
  const b = (body ?? {}) as {
    candidates?: Array<{
      content?: { parts?: unknown };
      finishReason?: string;
    }>;
    usageMetadata?: unknown;
  };
  const candidate = b.candidates?.[0];
  const { text, toolCalls } = partsToChat(candidate?.content?.parts, id);
  const message: Record<string, unknown> = { role: 'assistant' };
  if (toolCalls.length > 0) {
    message.content = text.length > 0 ? text : null;
    message.tool_calls = toolCalls;
  } else {
    message.content = text;
  }
  const finishReason =
    toolCalls.length > 0
      ? 'tool_calls'
      : geminiFinishToChat(candidate?.finishReason);

  const obj: Record<string, unknown> = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  const usage = geminiUsage(b.usageMetadata);
  if (usage) {
    obj.usage = usage;
  }
  return obj;
}
