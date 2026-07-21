/**
 * Generic OpenAI-compatible provider adapter (epic AIPP-4, subtask 4.3;
 * FR-PA-GEN-001/002).
 *
 * A parameterized adapter (base URL, auth env var, passthrough flag, extra
 * headers) instantiated for xai, openrouter, deepseek, groq, mistral, together,
 * fireworks, and perplexity. Chat Completions upstream, verbatim streaming with
 * usage extraction from the final chunk, bearer auth from env or (where allowed)
 * client passthrough. Per-provider parameters come from the legacy
 * DEFAULT_ENDPOINTS table.
 */

import { classifyOpenAIError } from './errors.js';
import type {
  CanonicalProviderRequest,
  ErrorClassifierInput,
  ProviderAdapter,
  ProviderAdapterConfig,
  ProviderCapabilities,
  ProviderUsage,
  StreamEvent,
  Transport,
  TransportRequest,
  TransportResponse,
} from './types.js';

/** Per-provider parameters for an OpenAI-compatible adapter. */
export interface OpenAICompatibleParams {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  /** Allow using the client's Authorization header instead of the env key. */
  authPassthroughAllowed?: boolean;
  extraHeaders?: Record<string, string>;
  capabilities?: Partial<ProviderCapabilities>;
}

/** The eight OpenAI-compatible providers (base URLs from legacy DEFAULT_ENDPOINTS). */
export const OPENAI_COMPATIBLE_PROVIDERS: OpenAICompatibleParams[] = [
  {
    id: 'xai',
    displayName: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    authPassthroughAllowed: true,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
  },
  {
    id: 'together',
    displayName: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
  },
  {
    id: 'perplexity',
    displayName: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
  },
];

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  vision: false,
  promptCaching: false,
  reasoning: false,
};

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

/** Parse an OpenAI-style SSE body into ordered events (`data:` lines, `[DONE]`). */
export function parseOpenAISse(raw: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    const dataStr = dataLines.join('\n');
    if (dataStr.length === 0) {
      continue;
    }
    if (dataStr === '[DONE]') {
      events.push({ event: 'done', data: '[DONE]' });
      continue;
    }
    try {
      events.push({
        event: 'chat.completion.chunk',
        data: JSON.parse(dataStr),
      });
    } catch {
      events.push({ event: 'chat.completion.chunk', data: dataStr });
    }
  }
  return events;
}

function extractUsageFrom(body: unknown): ProviderUsage | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const u = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
  };
}

/** Build an OpenAI-compatible adapter from per-provider parameters. */
export function createOpenAICompatibleAdapter(
  params: OpenAICompatibleParams,
  deps: { env?: NodeJS.ProcessEnv } = {},
): ProviderAdapter {
  const env = deps.env ?? process.env;
  const capabilities = {
    ...DEFAULT_CAPABILITIES,
    ...(params.capabilities ?? {}),
  };

  function resolveAuth(request: CanonicalProviderRequest): string | undefined {
    const passthrough = headerValue(request.headers, 'authorization');
    if (params.authPassthroughAllowed && passthrough) {
      return passthrough;
    }
    const key = env[params.apiKeyEnv];
    return key ? `Bearer ${key}` : undefined;
  }

  return {
    id: params.id,
    displayName: params.displayName,
    upstreamProtocols: ['openai_chat'],
    authModes: params.authPassthroughAllowed
      ? ['env', 'header_passthrough']
      : ['env'],
    capabilities,
    timeouts: { connectMs: 5000, requestMs: 120000, streamIdleMs: 60000 },
    retrySafety: { preStream: true, postStream: false },

    resolveBaseUrl: (config?: ProviderAdapterConfig) =>
      config?.baseUrl ?? params.baseUrl,

    serializeRequest: (request, config): TransportRequest => {
      const baseUrl = config?.baseUrl ?? params.baseUrl;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(params.extraHeaders ?? {}),
      };
      const auth = resolveAuth(request);
      if (auth) {
        headers.authorization = auth;
      }
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
      const choices = (body as { choices?: Array<{ finish_reason?: string }> })
        .choices;
      return {
        status: response.status,
        providerRequestId: headerValue(response.headers, 'x-request-id'),
        providerResponseId: (body as { id?: string }).id,
        usage: extractUsageFrom(body),
        stopReason: choices?.[0]?.finish_reason,
        body,
      };
    },

    parseStreamEvent: (raw: string) => parseOpenAISse(raw),

    classifyError: (input: ErrorClassifierInput) => classifyOpenAIError(input),

    extractUsage: (body: unknown) => extractUsageFrom(body),

    healthCheck: async (
      transport: Transport,
      config?: ProviderAdapterConfig,
    ) => {
      const baseUrl = config?.baseUrl ?? params.baseUrl;
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

/** Register all eight OpenAI-compatible providers into a registry. */
export function registerOpenAICompatibleProviders(
  registry: { register: (adapter: ProviderAdapter) => void },
  deps: { env?: NodeJS.ProcessEnv } = {},
): void {
  for (const params of OPENAI_COMPATIBLE_PROVIDERS) {
    registry.register(createOpenAICompatibleAdapter(params, deps));
  }
}
