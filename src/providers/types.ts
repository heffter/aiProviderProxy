/**
 * Provider adapter contract (epic AIPP-4, subtask 4.1; FR-PROV-001..015).
 *
 * Every upstream provider is reached through a ProviderAdapter with a uniform
 * shape: identity, declared capabilities and auth modes, request serialization,
 * response/stream parsing, error classification, usage extraction, and health
 * check. The transport (a fetch-like function) is injectable so adapters are
 * testable without real network access (FR-PROV-007).
 */

/** Canonical error categories (PRD section 13); retry logic keys on these only. */
export const ERROR_CATEGORIES = [
  'client_validation_error',
  'client_auth_error',
  'policy_rejected',
  'capability_unsupported',
  'provider_auth_error',
  'provider_rate_limited',
  'provider_overloaded',
  'provider_validation_error',
  'provider_timeout',
  'provider_connection_error',
  'provider_stream_error',
  'client_cancelled',
  'budget_exceeded',
  'internal_error',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Upstream wire protocols an adapter may speak. */
export type UpstreamProtocol =
  'anthropic' | 'openai_chat' | 'openai_responses' | 'gemini' | 'ollama';

/** How an adapter authenticates to its upstream. */
export type AuthMode =
  'env' | 'header_passthrough' | 'oauth' | 'token_pool' | 'none';

/** Declared provider capabilities. */
export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  promptCaching: boolean;
  reasoning: boolean;
}

/** Idle/connect/request timeouts (ms). */
export interface AdapterTimeouts {
  connectMs: number;
  requestMs: number;
  streamIdleMs: number;
}

/** Whether an attempt is safe to retry before/after streaming has begun. */
export interface RetrySafety {
  preStream: boolean;
  postStream: boolean;
}

/** A transport request (fetch-like). */
export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A transport response (fetch-like, body pre-read as text). */
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Injectable transport used by adapters. */
export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>;

/** Provider-neutral request the adapter serializes to its wire format. */
export interface CanonicalProviderRequest {
  /** Native (upstream) model id. */
  model: string;
  stream: boolean;
  /** Upstream-shaped body (already translated by the protocol layer). */
  body: Record<string, unknown>;
  /** Extra headers to merge (e.g. passthrough auth). */
  headers?: Record<string, string>;
  /** Which upstream protocol to target when an adapter speaks more than one. */
  upstreamProtocol?: UpstreamProtocol;
}

/** Token usage extracted from a provider response. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteShortTokens?: number;
  cacheWriteLongTokens?: number;
  reasoningTokens?: number;
  extra?: Record<string, number>;
}

/** A parsed non-streaming response. */
export interface ParsedResponse {
  status: number;
  providerRequestId?: string;
  providerResponseId?: string;
  usage?: ProviderUsage;
  stopReason?: string;
  body: unknown;
}

/** A single parsed stream event. */
export interface StreamEvent {
  event: string;
  data: unknown;
}

/** Input to {@link ProviderAdapter.classifyError}. */
export interface ErrorClassifierInput {
  status?: number;
  body?: unknown;
  /** A thrown transport error (connection reset, timeout, abort, ...). */
  cause?: unknown;
}

/** Config a provider adapter reads (subset of the provider config schema). */
export interface ProviderAdapterConfig {
  baseUrl?: string;
}

/** The uniform contract every provider adapter implements. */
export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly upstreamProtocols: readonly UpstreamProtocol[];
  readonly authModes: readonly AuthMode[];
  readonly capabilities: ProviderCapabilities;
  readonly timeouts: AdapterTimeouts;
  readonly retrySafety: RetrySafety;

  /** Resolve the upstream base URL (config override or the adapter default). */
  resolveBaseUrl(config?: ProviderAdapterConfig): string;
  /** Build the concrete transport request for a canonical request. */
  serializeRequest(
    request: CanonicalProviderRequest,
    config?: ProviderAdapterConfig,
  ): TransportRequest;
  /** Parse a non-streaming transport response. */
  parseResponse(response: TransportResponse): ParsedResponse;
  /** Parse a raw SSE/stream chunk into zero or more events. */
  parseStreamEvent(raw: string): StreamEvent[];
  /** Map a provider status/body/cause to a canonical error category. */
  classifyError(input: ErrorClassifierInput): ErrorCategory;
  /** Extract usage from a parsed response body, if present. */
  extractUsage(body: unknown): ProviderUsage | undefined;
  /** Lightweight health check using the injected transport. */
  healthCheck(
    transport: Transport,
    config?: ProviderAdapterConfig,
  ): Promise<boolean>;
}
