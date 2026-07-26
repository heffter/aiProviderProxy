/**
 * Ollama provider adapter (epic AIPP-8, subtask 8.4; FR-PA-OLL-001).
 *
 * Speaks Ollama's local `/api/chat` endpoint while presenting a Chat Completions
 * interface to the gateway: `serializeRequest` translates the chat body to the
 * Ollama shape, `parseResponse` translates the response into a `chat.completion`
 * (usage from `prompt_eval_count` / `eval_count`), and `parseStreamEvent`
 * translates the NDJSON stream (one JSON object per line) into
 * `chat.completion.chunk` records. Ollama is a local, unauthenticated upstream;
 * the health check hits `/api/tags`.
 */

import { uuidGen, type IdGen } from '../../lifecycle/index.js';
import type {
  CanonicalProviderRequest,
  ErrorCategory,
  ErrorClassifierInput,
  ProviderAdapter,
  ProviderAdapterConfig,
  ProviderUsage,
  StreamEvent,
  Transport,
  TransportRequest,
  TransportResponse,
} from '../types.js';
import {
  chatToOllamaRequest,
  ollamaChunkToChat,
  ollamaResponseToChat,
  ollamaUsage,
} from './translate.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Classify an Ollama error status/cause into a canonical category. */
export function classifyOllamaError(
  input: ErrorClassifierInput,
): ErrorCategory {
  if (input.cause) {
    const name = (input.cause as { name?: string }).name;
    if (name === 'AbortError') return 'client_cancelled';
    return 'provider_connection_error';
  }
  switch (input.status) {
    case 404:
      return 'provider_validation_error';
    case 400:
      return 'provider_validation_error';
    case 429:
      return 'provider_rate_limited';
    case 500:
    case 503:
      return 'provider_overloaded';
    default:
      return 'internal_error';
  }
}

/** Extract usage (ProviderUsage) from an Ollama response body. */
export function extractOllamaUsage(body: unknown): ProviderUsage | undefined {
  const usage = ollamaUsage(body);
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
  };
}

/** Dependencies for the Ollama adapter. */
export interface OllamaAdapterDeps {
  /** Chat-completion id generator; defaults to a UUID-backed generator. */
  genId?: IdGen;
  /** Epoch-millis clock; defaults to Date.now. */
  now?: () => number;
}

/** Build the Ollama adapter. */
export function createOllamaAdapter(
  deps: OllamaAdapterDeps = {},
): ProviderAdapter {
  const genId = deps.genId ?? uuidGen;
  const now = deps.now ?? Date.now;

  function chatId(): string {
    return `chatcmpl-${genId().replace(/-/g, '')}`;
  }

  return {
    id: 'ollama',
    displayName: 'Ollama',
    upstreamProtocols: ['ollama'],
    authModes: ['none'],
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      promptCaching: false,
      reasoning: false,
    },
    timeouts: { connectMs: 5000, requestMs: 300000, streamIdleMs: 120000 },
    retrySafety: { preStream: true, postStream: false },

    resolveBaseUrl: (config?: ProviderAdapterConfig) =>
      config?.baseUrl ?? DEFAULT_BASE_URL,

    serializeRequest: (
      request: CanonicalProviderRequest,
      config?: ProviderAdapterConfig,
    ): TransportRequest => {
      const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
      const ollamaBody = chatToOllamaRequest({
        ...request.body,
        model: request.model,
        stream: request.stream,
      });
      return {
        url: `${baseUrl}/api/chat`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ollamaBody),
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
      const id = chatId();
      const created = Math.floor(now() / 1000);
      const model = String((body as { model?: unknown })?.model ?? '');
      const chat = ollamaResponseToChat(body, model, id, created);
      const finishReason = (
        chat.choices as Array<{ finish_reason?: string }>
      )[0]?.finish_reason;
      return {
        status: response.status,
        providerRequestId: headerValue(response.headers, 'x-request-id'),
        providerResponseId: id,
        usage: extractOllamaUsage(body),
        stopReason: finishReason,
        body: chat,
      };
    },

    parseStreamEvent: (raw: string): StreamEvent[] => {
      const events: StreamEvent[] = [];
      // NDJSON: one JSON object per line (no `data:` framing).
      for (const line of raw.split(/\r?\n/)) {
        const data = ollamaChunkToChat(line);
        if (data) {
          events.push({ event: 'chat.completion.chunk', data });
        }
      }
      return events;
    },

    classifyError: (input: ErrorClassifierInput) => classifyOllamaError(input),

    extractUsage: (body: unknown) => extractOllamaUsage(body),

    healthCheck: async (
      transport: Transport,
      config?: ProviderAdapterConfig,
    ) => {
      const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
      try {
        const res = await transport({
          url: `${baseUrl}/api/tags`,
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
