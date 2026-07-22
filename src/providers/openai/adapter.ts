/**
 * OpenAI provider adapter (epic AIPP-4, subtask 4.5; FR-PA-OAI-002/003/009).
 *
 * Speaks two upstream protocols: Chat Completions (/chat/completions) and
 * Responses (/responses), selected per request via `upstreamProtocol`. Captures
 * the x-request-id header and response id, usage including cached input tokens
 * (prompt_tokens_details/input_tokens_details.cached_tokens) and reasoning
 * tokens, the service tier when present, and the terminal status for the
 * Responses protocol (completed/failed/incomplete). Streaming is parsed without
 * buffering; stream cancellation and idle-timeout are enforced by the gateway
 * using this adapter's declared timeouts.
 */

import { classifyOpenAIError } from '../errors.js';
import type {
  CanonicalProviderRequest,
  ErrorClassifierInput,
  ProviderAdapter,
  ProviderAdapterConfig,
  ProviderUsage,
  StreamEvent,
  Transport,
  TransportRequest,
  TransportResponse,
} from '../types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

/** Parse an OpenAI SSE body for either protocol (event optional, `[DONE]`). */
export function parseOpenAIStream(raw: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    const dataStr = dataLines.join('\n');
    if (dataStr.length === 0 && event.length === 0) {
      continue;
    }
    if (dataStr === '[DONE]') {
      events.push({ event: 'done', data: '[DONE]' });
      continue;
    }
    let data: unknown = dataStr;
    if (dataStr.length > 0) {
      try {
        data = JSON.parse(dataStr);
      } catch {
        data = dataStr;
      }
    }
    if (event.length === 0) {
      const type =
        data && typeof data === 'object'
          ? (data as { type?: unknown }).type
          : undefined;
      event = typeof type === 'string' ? type : 'chat.completion.chunk';
    }
    events.push({ event, data });
  }
  return events;
}

interface OpenAIUsageShape {
  // Chat Completions
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  // Responses
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

/** Extract usage for either the Chat Completions or Responses shape. */
export function extractOpenAIUsage(body: unknown): ProviderUsage | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const usage = (body as { usage?: OpenAIUsageShape }).usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  if (
    usage.prompt_tokens !== undefined ||
    usage.completion_tokens !== undefined
  ) {
    return {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
    };
  }
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.input_tokens_details?.cached_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  };
}

/** Dependencies for the OpenAI adapter. */
export interface OpenAIAdapterDeps {
  env?: NodeJS.ProcessEnv;
}

/** Build the OpenAI adapter (Chat Completions + Responses). */
export function createOpenAIAdapter(
  deps: OpenAIAdapterDeps = {},
): ProviderAdapter {
  const env = deps.env ?? process.env;

  function resolveAuth(request: CanonicalProviderRequest): string | undefined {
    const passthrough = headerValue(request.headers, 'authorization');
    if (passthrough) {
      return passthrough;
    }
    const key = env.OPENAI_API_KEY;
    return key ? `Bearer ${key}` : undefined;
  }

  return {
    id: 'openai',
    displayName: 'OpenAI',
    upstreamProtocols: ['openai_chat', 'openai_responses'],
    authModes: ['env', 'header_passthrough'],
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      promptCaching: true,
      reasoning: true,
    },
    timeouts: { connectMs: 5000, requestMs: 120000, streamIdleMs: 60000 },
    retrySafety: { preStream: true, postStream: false },

    resolveBaseUrl: (config?: ProviderAdapterConfig) =>
      config?.baseUrl ?? DEFAULT_BASE_URL,

    serializeRequest: (request, config): TransportRequest => {
      const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
      const path =
        request.upstreamProtocol === 'openai_responses'
          ? '/responses'
          : '/chat/completions';
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      const auth = resolveAuth(request);
      if (auth) {
        headers.authorization = auth;
      }
      return {
        url: `${baseUrl}${path}`,
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
      };
    },

    parseResponse: (response: TransportResponse) => {
      let body: unknown = response.body;
      if (response.body.length > 0) {
        try {
          body = JSON.parse(response.body);
        } catch {
          body = response.body;
        }
      }
      const b = body as {
        id?: string;
        status?: string;
        service_tier?: string;
        choices?: Array<{ finish_reason?: string }>;
      };
      // Responses protocol reports a terminal status; Chat reports finish_reason.
      const stopReason = b.status ?? b.choices?.[0]?.finish_reason;
      return {
        status: response.status,
        providerRequestId: headerValue(response.headers, 'x-request-id'),
        providerResponseId: b.id,
        usage: extractOpenAIUsage(body),
        stopReason,
        body,
      };
    },

    parseStreamEvent: (raw: string) => parseOpenAIStream(raw),

    classifyError: (input: ErrorClassifierInput) => classifyOpenAIError(input),

    extractUsage: (body: unknown) => extractOpenAIUsage(body),

    healthCheck: async (
      transport: Transport,
      config?: ProviderAdapterConfig,
    ) => {
      const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
      try {
        const res = await transport({
          url: `${baseUrl}/models`,
          method: 'GET',
          headers: {},
        });
        return res.status < 500;
      } catch {
        return false;
      }
    },
  };
}

/** Extract the OpenAI service tier from a response body, if present. */
export function extractServiceTier(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const tier = (body as { service_tier?: unknown }).service_tier;
    if (typeof tier === 'string') {
      return tier;
    }
  }
  return undefined;
}
