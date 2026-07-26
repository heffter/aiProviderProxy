/**
 * Google Gemini provider adapter (epic AIPP-8, subtask 8.3; FR-PA-GOO-001).
 *
 * Speaks the Gemini `generateContent` upstream protocol while presenting a Chat
 * Completions interface to the gateway: `serializeRequest` translates the chat
 * body to the Gemini shape and targets `:generateContent` (or
 * `:streamGenerateContent`), and `parseResponse` / `parseStreamEvent` translate
 * the Gemini response and SSE chunks back into `chat.completion` /
 * `chat.completion.chunk` objects. Usage comes from `usageMetadata`; auth uses
 * `GOOGLE_API_KEY` via the `x-goog-api-key` header.
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
  chatToGeminiRequest,
  geminiFinishToChat,
  geminiResponseToChat,
  geminiUsage,
} from './translate.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

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

/** Classify a Gemini error status/cause into a canonical category. */
export function classifyGeminiError(
  input: ErrorClassifierInput,
): ErrorCategory {
  if (input.cause) {
    const name = (input.cause as { name?: string }).name;
    if (name === 'AbortError') return 'client_cancelled';
    return 'provider_connection_error';
  }
  switch (input.status) {
    case 401:
    case 403:
      return 'provider_auth_error';
    case 429:
      return 'provider_rate_limited';
    case 400:
    case 404:
      return 'provider_validation_error';
    case 500:
    case 503:
      return 'provider_overloaded';
    default:
      return 'internal_error';
  }
}

/** Extract usage (ProviderUsage) from a Gemini response body. */
export function extractGeminiUsage(body: unknown): ProviderUsage | undefined {
  const usage = geminiUsage(
    (body as { usageMetadata?: unknown })?.usageMetadata,
  );
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
  };
}

/** Dependencies for the Google adapter. */
export interface GoogleAdapterDeps {
  env?: NodeJS.ProcessEnv;
  /** Chat-completion id generator; defaults to a UUID-backed generator. */
  genId?: IdGen;
  /** Epoch-millis clock; defaults to Date.now. */
  now?: () => number;
}

/** Build the Google Gemini adapter. */
export function createGoogleAdapter(
  deps: GoogleAdapterDeps = {},
): ProviderAdapter {
  const env = deps.env ?? process.env;
  const genId = deps.genId ?? uuidGen;
  const now = deps.now ?? Date.now;

  function chatId(): string {
    return `chatcmpl-${genId().replace(/-/g, '')}`;
  }

  return {
    id: 'google',
    displayName: 'Google Gemini',
    upstreamProtocols: ['gemini'],
    authModes: ['env'],
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      promptCaching: false,
      reasoning: false,
    },
    timeouts: { connectMs: 5000, requestMs: 120000, streamIdleMs: 60000 },
    retrySafety: { preStream: true, postStream: false },

    resolveBaseUrl: (config?: ProviderAdapterConfig) =>
      config?.baseUrl ?? DEFAULT_BASE_URL,

    serializeRequest: (
      request: CanonicalProviderRequest,
      config?: ProviderAdapterConfig,
    ): TransportRequest => {
      const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
      const method = request.stream
        ? 'streamGenerateContent'
        : 'generateContent';
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      const key =
        headerValue(request.headers, 'x-goog-api-key') ?? env.GOOGLE_API_KEY;
      if (key) {
        headers['x-goog-api-key'] = key;
      }
      return {
        url: `${baseUrl}/models/${request.model}:${method}`,
        method: 'POST',
        headers,
        body: JSON.stringify(chatToGeminiRequest(request.body)),
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
      const id = headerValue(response.headers, 'x-request-id') ?? chatId();
      const created = Math.floor(now() / 1000);
      const model = String(
        (body as { modelVersion?: unknown })?.modelVersion ?? '',
      );
      const chat = geminiResponseToChat(body, model, id, created);
      const finishReason = (
        chat.choices as Array<{ finish_reason?: string }>
      )[0]?.finish_reason;
      return {
        status: response.status,
        providerRequestId: headerValue(response.headers, 'x-request-id'),
        providerResponseId: id,
        usage: extractGeminiUsage(body),
        stopReason: finishReason,
        body: chat,
      };
    },

    parseStreamEvent: (raw: string): StreamEvent[] => {
      const events: StreamEvent[] = [];
      for (const block of raw.split(/\r?\n\r?\n/)) {
        const dataLines = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice('data:'.length).trim());
        const dataStr = dataLines.join('\n');
        if (dataStr.length === 0) continue;
        if (dataStr === '[DONE]') {
          events.push({ event: 'done', data: '[DONE]' });
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }
        const candidate = (
          parsed as {
            candidates?: Array<{
              content?: { parts?: unknown };
              finishReason?: string;
            }>;
          }
        ).candidates?.[0];
        const parts = candidate?.content?.parts;
        let text = '';
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const t = (part as { text?: unknown }).text;
            if (typeof t === 'string') text += t;
          }
        }
        events.push({
          event: 'chat.completion.chunk',
          data: {
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: text.length > 0 ? { content: text } : {},
                finish_reason: candidate?.finishReason
                  ? geminiFinishToChat(candidate.finishReason)
                  : null,
              },
            ],
          },
        });
      }
      return events;
    },

    classifyError: (input: ErrorClassifierInput) => classifyGeminiError(input),

    extractUsage: (body: unknown) => extractGeminiUsage(body),

    healthCheck: async (
      transport: Transport,
      config?: ProviderAdapterConfig,
    ) => {
      const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
      try {
        const res = await transport({
          url: `${baseUrl}/models`,
          method: 'GET',
          headers: env.GOOGLE_API_KEY
            ? { 'x-goog-api-key': env.GOOGLE_API_KEY }
            : {},
        });
        return res.status < 500;
      } catch {
        return false;
      }
    },
  };
}
