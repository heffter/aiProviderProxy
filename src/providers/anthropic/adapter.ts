/**
 * Anthropic Messages provider adapter (epic AIPP-4, subtask 4.4;
 * FR-PA-ANT-001..).
 *
 * Native Messages upstream with hybrid auth (x-api-key / OAT bearer, client
 * passthrough, or a pooled key), the ported token pool, per-attempt request-id
 * capture (new -- nowhere captured today), and the Anthropic cache-write split
 * (ephemeral_5m / ephemeral_1h) in addition to aggregates, required by the
 * Tokemetry short/long cache fields. Streaming is parsed without buffering.
 */

import { classifyAnthropicError } from '../errors.js';
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
import { buildAnthropicHeaders, type AnthropicAuthContext } from './auth.js';
import type { TokenPool } from './token-pool.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

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

/** Parse an Anthropic SSE body into ordered events (`event:` + `data:` blocks). */
export function parseAnthropicSse(raw: string): StreamEvent[] {
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
    let data: unknown = dataStr;
    if (dataStr.length > 0) {
      try {
        data = JSON.parse(dataStr);
      } catch {
        data = dataStr;
      }
    }
    if (event.length === 0 && data && typeof data === 'object') {
      const t = (data as { type?: unknown }).type;
      if (typeof t === 'string') {
        event = t;
      }
    }
    events.push({ event: event || 'message', data });
  }
  return events;
}

interface AnthropicUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/** Extract usage with the 5m/1h cache-write split plus the aggregate. */
export function extractAnthropicUsage(
  body: unknown,
): ProviderUsage | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const usage = (body as { usage?: AnthropicUsageShape }).usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const aggregate = usage.cache_creation_input_tokens;
  const short = usage.cache_creation?.ephemeral_5m_input_tokens;
  const long = usage.cache_creation?.ephemeral_1h_input_tokens;
  // When only the aggregate is present, attribute it to the short (5m) bucket.
  const shortResolved =
    short ?? (long === undefined ? aggregate : undefined) ?? 0;
  const extra: Record<string, number> = {};
  if (aggregate !== undefined) {
    extra.cache_creation_input_tokens = aggregate;
  }
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteShortTokens: shortResolved,
    cacheWriteLongTokens: long ?? 0,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

/** Dependencies for the Anthropic adapter. */
export interface AnthropicAdapterDeps {
  env?: NodeJS.ProcessEnv;
  /** Optional multi-credential token pool. */
  tokenPool?: TokenPool;
}

/** Build the Anthropic Messages adapter. */
export function createAnthropicAdapter(
  deps: AnthropicAdapterDeps = {},
): ProviderAdapter {
  const env = deps.env ?? process.env;

  function authContext(
    request: CanonicalProviderRequest,
  ): AnthropicAuthContext {
    return {
      authHeader: headerValue(request.headers, 'authorization'),
      apiKeyHeader: headerValue(request.headers, 'x-api-key'),
      betaHeaders: headerValue(request.headers, 'anthropic-beta'),
      versionHeader: headerValue(request.headers, 'anthropic-version'),
      userAgent: headerValue(request.headers, 'user-agent'),
      xApp: headerValue(request.headers, 'x-app'),
    };
  }

  return {
    id: 'anthropic',
    displayName: 'Anthropic',
    upstreamProtocols: ['anthropic'],
    authModes: ['env', 'header_passthrough', 'oauth', 'token_pool'],
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
      const ctx = authContext(request);
      const hasPassthrough = Boolean(ctx.authHeader || ctx.apiKeyHeader);
      const fallbackKey = hasPassthrough
        ? undefined
        : (deps.tokenPool?.selectToken()?.apiKey ?? env.ANTHROPIC_API_KEY);
      return {
        url: `${baseUrl}/messages`,
        method: 'POST',
        headers: buildAnthropicHeaders(ctx, fallbackKey),
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
      return {
        status: response.status,
        providerRequestId:
          headerValue(response.headers, 'request-id') ??
          headerValue(response.headers, 'anthropic-request-id'),
        providerResponseId: (body as { id?: string }).id,
        usage: extractAnthropicUsage(body),
        stopReason: (body as { stop_reason?: string }).stop_reason,
        body,
      };
    },

    parseStreamEvent: (raw: string) => parseAnthropicSse(raw),

    classifyError: (input: ErrorClassifierInput) =>
      classifyAnthropicError(input),

    extractUsage: (body: unknown) => extractAnthropicUsage(body),

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
