/**
 * Z.ai GLM provider adapter (epic AIPP-9, subtask 9.1; FR-PA-ZAI-001..004).
 *
 * A specialization of the generic OpenAI-compatible Chat Completions adapter for
 * Z.ai's GLM models: base URL `https://api.z.ai/api/paas/v4`, bearer auth from
 * `ZAI_API_KEY` (or a client Authorization passthrough), the GLM request
 * extensions (`thinking`, `reasoning_effort`, `tool_stream`) forwarded verbatim,
 * and the GLM response extras captured -- the request id, and the GLM-specific
 * numeric usage counters namespaced under `usage.extra['zai.*']`. Reasoning text
 * (`reasoning_content`) is left in the response body for the cross-protocol
 * mapping (subtask 9.3); it is never placed into the telemetry usage.
 */

import { classifyOpenAIError } from '../errors.js';
import { parseOpenAISse } from '../openai-compatible.js';
import type {
  CanonicalProviderRequest,
  ErrorClassifierInput,
  ProviderAdapter,
  ProviderAdapterConfig,
  ProviderUsage,
  Transport,
  TransportRequest,
  TransportResponse,
} from '../types.js';
import {
  extractGlmResponseExtras,
  extractGlmUsageExtras,
} from './extensions.js';

const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4';

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

/** Extract usage including cached prompt tokens and namespaced GLM counters. */
export function extractZaiUsage(body: unknown): ProviderUsage | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  const extra = extractGlmUsageExtras(usage);
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

/** Dependencies for the Z.ai adapter. */
export interface ZaiAdapterDeps {
  env?: NodeJS.ProcessEnv;
}

/** Build the Z.ai GLM adapter. */
export function createZaiAdapter(deps: ZaiAdapterDeps = {}): ProviderAdapter {
  const env = deps.env ?? process.env;

  function resolveAuth(request: CanonicalProviderRequest): string | undefined {
    const passthrough = headerValue(request.headers, 'authorization');
    if (passthrough) return passthrough;
    const key = env.ZAI_API_KEY;
    return key ? `Bearer ${key}` : undefined;
  }

  return {
    id: 'zai',
    displayName: 'Z.ai (GLM)',
    upstreamProtocols: ['openai_chat'],
    authModes: ['env', 'header_passthrough'],
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      promptCaching: true,
      reasoning: true,
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
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      const auth = resolveAuth(request);
      if (auth) headers.authorization = auth;
      // The body already carries any GLM extensions (thinking / reasoning_effort
      // / tool_stream) added by the translation layer; forward it verbatim.
      return {
        url: `${baseUrl}/chat/completions`,
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
      const requestId = headerValue(response.headers, 'x-request-id');
      const extras = extractGlmResponseExtras(body, requestId);
      const choices = (body as { choices?: Array<{ finish_reason?: string }> })
        .choices;
      return {
        status: response.status,
        providerRequestId: extras.requestId,
        providerResponseId: (body as { id?: string }).id,
        usage: extractZaiUsage(body),
        stopReason: choices?.[0]?.finish_reason,
        body,
      };
    },

    parseStreamEvent: (raw: string) => parseOpenAISse(raw),

    classifyError: (input: ErrorClassifierInput) => classifyOpenAIError(input),

    extractUsage: (body: unknown) => extractZaiUsage(body),

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
