/**
 * Gateway HTTP server (epic AIPP-6, subtask 6.2).
 *
 * The provider-neutral core wired end to end: it parses an Anthropic Messages
 * request (AIPP-6), builds a RequestContext/Attempt (AIPP-3), resolves the model
 * (AIPP-4), dispatches through a provider adapter (AIPP-4) -- verbatim for the
 * Anthropic fast path, translated for OpenAI-style upstreams (AIPP-6) -- then
 * emits a content-free canonical usage event to the sink registry (AIPP-3) and
 * the Tokemetry outbox (AIPP-5). Non-streaming path; SSE lands with 6.3.
 *
 * `handle()` is a pure request handler (testable against a mock transport);
 * `listen()` wraps it in a node:http server.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config/index.js';
import {
  RequestContext,
  buildUsageEvent,
  type Clock,
  type EventSinkRegistry,
  type IdGen,
  type TerminalState,
} from '../lifecycle/index.js';
import { ProviderRegistryError } from '../providers/registry.js';
import type {
  CanonicalProviderRequest,
  ErrorCategory,
  ProviderAdapter,
  ProviderUsage,
  Transport,
} from '../providers/types.js';
import { resolveModel } from '../models/index.js';
import {
  anthropicError,
  anthropicToOpenAIRequest,
  openAIResponseToAnthropic,
  parseMessagesRequest,
  statusForAnthropicError,
  type AnthropicErrorEnvelope,
  type AnthropicErrorType,
  type ParsedMessagesRequest,
} from '../protocols/anthropic/index.js';
import type { TokemetryOutbox } from '../integrations/tokemetry/index.js';
import {
  buildResponsesObject,
  chatResponseToCanonical,
  decideHostedTools,
  encodeResponsesStream,
  parseResponsesRequest,
  responsesError,
  responsesToChatBody,
  responsesRequestedToolNames,
  streamEventsForResult,
  stripDeniedFunctionTools,
  type ResponsesEcho,
  type ResponsesErrorEnvelope,
  type ResponsesErrorType,
} from '../protocols/openai-responses/index.js';
import {
  anthropicResponseToChat,
  buildChatCompletion,
  chatError,
  chatToAnthropicRequest,
  encodeChatStream,
  parseChatRequest,
  streamEventsForChatResult,
  type ChatErrorEnvelope,
  type ChatErrorType,
  type ParsedChatRequest,
} from '../protocols/openai-chat/index.js';
import { ToolAuthorizer, decideToolEnforcement } from '../tools/index.js';
import { httpTransport } from './transport.js';

/** A gateway request (transport-agnostic). */
export interface GatewayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Aborted when the client disconnects; cancels the upstream request. */
  signal?: AbortSignal;
}

/** A gateway response. */
export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface GatewayDeps {
  config: Config;
  registry: { get(id: string): ProviderAdapter; has(id: string): boolean };
  transport?: Transport;
  sinks?: EventSinkRegistry;
  outbox?: TokemetryOutbox;
  /** Tool authorization; defaults to one built from `config.tools`. */
  toolAuthorizer?: ToolAuthorizer;
  clock?: Clock;
  genId?: IdGen;
  now?: () => number;
}

function header(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

function json(status: number, body: unknown): GatewayResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function errorResponse(envelope: AnthropicErrorEnvelope): GatewayResponse {
  return json(statusForAnthropicError(envelope.error.type), envelope);
}

/** Extract the tool names from an Anthropic `tools` array (skip malformed). */
function requestedToolNames(tools: unknown[] | undefined): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const names: string[] = [];
  for (const tool of tools) {
    const name = (tool as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Drop denied tools from a request (both the typed `tools` and the raw body)
 * so the model cannot call them even when only a partial set was denied.
 */
function stripDeniedTools(
  request: ParsedMessagesRequest,
  allowed: Set<string>,
): void {
  const keep = (tool: unknown): boolean => {
    const name = (tool as { name?: unknown }).name;
    return typeof name === 'string' && allowed.has(name);
  };
  if (Array.isArray(request.tools)) {
    request.tools = request.tools.filter(keep);
  }
  const rawTools = (request.raw as { tools?: unknown }).tools;
  if (Array.isArray(rawTools)) {
    (request.raw as { tools: unknown[] }).tools = rawTools.filter(keep);
  }
}

/** Map a canonical error category to an Anthropic client error type. */
export function categoryToAnthropicError(
  category: ErrorCategory,
): AnthropicErrorType {
  switch (category) {
    case 'provider_auth_error':
    case 'client_auth_error':
      return 'authentication_error';
    case 'policy_rejected':
      return 'permission_error';
    case 'provider_rate_limited':
      return 'rate_limit_error';
    case 'provider_overloaded':
      return 'overloaded_error';
    case 'provider_validation_error':
    case 'client_validation_error':
      return 'invalid_request_error';
    default:
      return 'api_error';
  }
}

/** Map a canonical error category to an OpenAI Responses client error. */
export function categoryToResponsesError(category: ErrorCategory): {
  type: ResponsesErrorType;
  status: number;
} {
  switch (category) {
    case 'provider_auth_error':
    case 'client_auth_error':
      return { type: 'authentication_error', status: 401 };
    case 'policy_rejected':
      return { type: 'permission_error', status: 403 };
    case 'provider_rate_limited':
    case 'provider_overloaded':
      return { type: 'rate_limit_error', status: 429 };
    case 'provider_validation_error':
    case 'client_validation_error':
    case 'capability_unsupported':
      return { type: 'invalid_request_error', status: 400 };
    default:
      return { type: 'server_error', status: 500 };
  }
}

/** An OpenAI-shaped error response for the Responses surface. */
function responsesErrorResponse(
  status: number,
  envelope: ResponsesErrorEnvelope,
): GatewayResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  };
}

/** Map a canonical error category to an OpenAI Chat client error. */
export function categoryToChatError(category: ErrorCategory): {
  type: ChatErrorType;
  status: number;
} {
  switch (category) {
    case 'provider_auth_error':
    case 'client_auth_error':
      return { type: 'authentication_error', status: 401 };
    case 'policy_rejected':
      return { type: 'permission_error', status: 403 };
    case 'provider_rate_limited':
    case 'provider_overloaded':
      return { type: 'rate_limit_error', status: 429 };
    case 'provider_validation_error':
    case 'client_validation_error':
    case 'capability_unsupported':
      return { type: 'invalid_request_error', status: 400 };
    default:
      return { type: 'server_error', status: 500 };
  }
}

/** An OpenAI-shaped error response for the Chat surface. */
function chatErrorResponse(
  status: number,
  envelope: ChatErrorEnvelope,
): GatewayResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  };
}

/** The function-tool names in a chat `tools` array (skip malformed). */
function requestedChatToolNames(tools: unknown[] | undefined): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const names: string[] = [];
  for (const tool of tools) {
    const name = (tool as { function?: { name?: unknown } }).function?.name;
    if (typeof name === 'string' && name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

/** Drop denied function tools from a chat request (typed + raw). */
function stripDeniedChatTools(
  request: ParsedChatRequest,
  allowed: Set<string>,
): void {
  const keep = (tool: unknown): boolean => {
    const name = (tool as { function?: { name?: unknown } }).function?.name;
    return typeof name === 'string' && allowed.has(name);
  };
  if (Array.isArray(request.tools)) {
    request.tools = request.tools.filter(keep);
  }
  const rawTools = (request.raw as { tools?: unknown }).tools;
  if (Array.isArray(rawTools)) {
    (request.raw as { tools: unknown[] }).tools = rawTools.filter(keep);
  }
}

/** Request-derived fields echoed back onto a reconstructed Responses object. */
function buildResponsesEcho(request: {
  instructions?: string;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
  parallelToolCalls?: boolean;
  temperature?: number;
  topP?: number;
  toolChoice?: unknown;
  reasoningEffort?: string;
  reasoningSummary?: unknown;
  raw: Record<string, unknown>;
}): ResponsesEcho {
  const rawTools = (request.raw as { tools?: unknown }).tools;
  return {
    instructions: request.instructions ?? null,
    maxOutputTokens: request.maxOutputTokens ?? null,
    metadata: request.metadata,
    parallelToolCalls: request.parallelToolCalls,
    temperature: request.temperature ?? null,
    topP: request.topP ?? null,
    toolChoice: request.toolChoice,
    tools: Array.isArray(rawTools) ? rawTools : undefined,
    reasoning:
      request.reasoningEffort !== undefined
        ? {
            effort: request.reasoningEffort,
            summary: request.reasoningSummary ?? null,
          }
        : undefined,
  };
}

function categoryToTerminalState(category: ErrorCategory): TerminalState {
  switch (category) {
    case 'provider_timeout':
      return 'timeout';
    case 'client_cancelled':
      return 'client_cancelled';
    case 'client_validation_error':
    case 'provider_validation_error':
      return 'validation_error';
    case 'policy_rejected':
      return 'policy_rejected';
    default:
      return 'upstream_error';
  }
}

export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly transport: Transport;
  private readonly toolAuthorizer: ToolAuthorizer;
  private server?: Server;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.transport = deps.transport ?? httpTransport;
    this.toolAuthorizer =
      deps.toolAuthorizer ?? new ToolAuthorizer(deps.config.tools);
  }

  /** Handle a single request. Never throws for ordinary errors. */
  async handle(request: GatewayRequest): Promise<GatewayResponse> {
    const path = request.url.split('?')[0];
    if (
      request.method === 'GET' &&
      (path === '/health' || path === '/healthz')
    ) {
      return json(200, { status: 'ok', service: 'aiproviderproxy' });
    }
    if (request.method === 'POST' && path === '/v1/messages') {
      return this.handleMessages(request);
    }
    if (request.method === 'POST' && path === '/v1/messages/count_tokens') {
      return this.handleCountTokens(request);
    }
    if (request.method === 'POST' && path === '/v1/responses') {
      return this.handleResponses(request);
    }
    if (request.method === 'POST' && path === '/v1/chat/completions') {
      return this.handleChat(request);
    }
    return errorResponse(
      anthropicError(
        'not_found_error',
        `No route for ${request.method} ${path}`,
      ),
    );
  }

  private emit(
    ctx: RequestContext,
    attempt: RequestContext['attempts'][number],
    input: {
      success: boolean;
      outcome: string;
      httpStatus?: number;
      providerRequestId?: string;
      providerResponseId?: string;
      stopReason?: string;
      usage?: ProviderUsage;
    },
  ): void {
    const event = buildUsageEvent({
      ctx,
      attempt,
      eventKind: 'logical_request',
      finality: 'final',
      sequence: 0,
      success: input.success,
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      providerRequestId: input.providerRequestId,
      providerResponseId: input.providerResponseId,
      stopReason: input.stopReason,
      streaming: ctx.streaming,
      tokens: {
        inputTokens: input.usage?.inputTokens ?? 0,
        outputTokens: input.usage?.outputTokens ?? 0,
        cacheReadTokens: input.usage?.cacheReadTokens,
        cacheWriteShortTokens: input.usage?.cacheWriteShortTokens,
        cacheWriteLongTokens: input.usage?.cacheWriteLongTokens,
        reasoningTokens: input.usage?.reasoningTokens,
        extra: input.usage?.extra,
      },
      provenance: input.usage ? 'provider_reported' : 'local_estimate',
    });
    try {
      this.deps.sinks?.emitLogicalRequestFinal(event);
      this.deps.outbox?.enqueue(event);
    } catch {
      // telemetry is best-effort and must never affect the response
    }
  }

  private async handleMessages(
    request: GatewayRequest,
  ): Promise<GatewayResponse> {
    const parsed = parseMessagesRequest(request.body);
    if (!parsed.ok) {
      return errorResponse(parsed.error);
    }

    const resolved = resolveModel(parsed.request.model, {
      overrides: this.deps.config.models.overrides,
    });
    if (!resolved) {
      return errorResponse(
        anthropicError(
          'invalid_request_error',
          `Unknown model "${parsed.request.model}"`,
        ),
      );
    }

    const ctx = new RequestContext(
      {
        clientProtocol: 'anthropic_messages',
        requestedModel: parsed.request.model,
        sessionId: header(request.headers, 'x-claude-code-session-id'),
        streaming: parsed.request.stream,
      },
      { clock: this.deps.clock, genId: this.deps.genId },
    );

    let adapter: ProviderAdapter;
    try {
      adapter = this.deps.registry.get(resolved.provider);
    } catch (err) {
      if (err instanceof ProviderRegistryError) {
        const attempt = ctx.startAttempt({
          provider: resolved.provider,
          upstreamProtocol: 'unknown',
          routedModel: resolved.model,
          nativeModel: resolved.model,
        });
        attempt.complete('internal_error');
        ctx.complete('internal_error');
        this.emit(ctx, attempt, {
          success: false,
          outcome: 'capability_unsupported',
        });
        return errorResponse(anthropicError('not_found_error', err.message));
      }
      throw err;
    }

    const verbatim = resolved.provider === 'anthropic';
    const upstreamProtocol = verbatim ? 'anthropic' : 'openai_chat';
    const attempt = ctx.startAttempt({
      provider: resolved.provider,
      upstreamProtocol,
      routedModel: resolved.model,
      nativeModel: resolved.model,
    });

    // Tool authorization: evaluate configured packs against the requested tools
    // before forwarding (FR-TOOLS-008). Reject when every tool is denied; strip
    // the denied subset otherwise.
    let toolsDeniedHeader: string | undefined;
    const requestedTools = requestedToolNames(parsed.request.tools);
    if (requestedTools.length > 0) {
      const decision = decideToolEnforcement(
        this.toolAuthorizer,
        request.headers,
        header(request.headers, 'x-claude-code-session-id') ?? '',
        requestedTools,
      );
      if (decision.action === 'reject') {
        attempt.complete('policy_rejected');
        ctx.complete('policy_rejected');
        this.emit(ctx, attempt, {
          success: false,
          outcome: 'policy_rejected',
        });
        return errorResponse(
          anthropicError(
            'permission_error',
            'All requested tools are denied by the active tool pack policy ' +
              `(denied: ${decision.result.deniedHeader}).`,
          ),
        );
      }
      if (decision.action === 'strip') {
        stripDeniedTools(parsed.request, new Set(decision.result.allowed));
        toolsDeniedHeader = decision.result.deniedHeader;
      }
    }

    const providerRequest: CanonicalProviderRequest = verbatim
      ? {
          model: resolved.model,
          stream: parsed.request.stream,
          body: { ...parsed.request.raw, model: resolved.model },
          headers: request.headers,
          upstreamProtocol: 'anthropic',
        }
      : {
          model: resolved.model,
          stream: parsed.request.stream,
          body: anthropicToOpenAIRequest(parsed.request, resolved.model)
            .body as unknown as Record<string, unknown>,
          headers: request.headers,
          upstreamProtocol: 'openai_chat',
        };

    let transportResponse;
    try {
      transportResponse = await this.transport(
        adapter.serializeRequest(providerRequest),
        { signal: request.signal },
      );
    } catch (cause) {
      // A client disconnect surfaces as an abort; disambiguate it from an
      // upstream timeout (which the classifier cannot tell apart) so the
      // attempt is recorded as client_cancelled (FR-ANTH-016, FR-USAGE-012).
      const category: ErrorCategory = request.signal?.aborted
        ? 'client_cancelled'
        : adapter.classifyError({ cause });
      attempt.complete(categoryToTerminalState(category));
      ctx.complete(categoryToTerminalState(category));
      this.emit(ctx, attempt, { success: false, outcome: category });
      return errorResponse(
        anthropicError(
          categoryToAnthropicError(category),
          'Upstream request failed',
        ),
      );
    }

    const parsedResponse = adapter.parseResponse(transportResponse);

    if (transportResponse.status < 200 || transportResponse.status >= 300) {
      const category = adapter.classifyError({
        status: transportResponse.status,
        body: parsedResponse.body,
      });
      attempt.complete(
        categoryToTerminalState(category),
        transportResponse.status,
      );
      ctx.complete(categoryToTerminalState(category));
      this.emit(ctx, attempt, {
        success: false,
        outcome: category,
        httpStatus: transportResponse.status,
        providerRequestId: parsedResponse.providerRequestId,
        usage: parsedResponse.usage,
      });
      return errorResponse(
        anthropicError(
          categoryToAnthropicError(category),
          `Upstream error ${transportResponse.status}`,
        ),
      );
    }

    attempt.complete('success', transportResponse.status);
    ctx.complete('success');
    this.emit(ctx, attempt, {
      success: true,
      outcome: 'success',
      httpStatus: transportResponse.status,
      providerRequestId: parsedResponse.providerRequestId,
      providerResponseId: parsedResponse.providerResponseId,
      stopReason: parsedResponse.stopReason,
      usage: parsedResponse.usage,
    });

    // Fast path: return the Anthropic body verbatim; otherwise translate.
    const responseBody = verbatim
      ? parsedResponse.body
      : openAIResponseToAnthropic(parsedResponse.body, resolved.model);
    const outHeaders: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (parsedResponse.providerRequestId) {
      outHeaders['request-id'] = parsedResponse.providerRequestId;
    }
    if (toolsDeniedHeader) {
      outHeaders['x-aipp-tools-denied'] = toolsDeniedHeader;
    }
    return {
      status: 200,
      headers: outHeaders,
      body: JSON.stringify(responseBody),
    };
  }

  /**
   * Anthropic `POST /v1/messages/count_tokens` passthrough. Anthropic-only:
   * requests routed to any other provider get an explicit capability error
   * rather than a misrouted or bogus count (port of legacy
   * standalone-proxy.ts:6253-6269).
   */
  private async handleCountTokens(
    request: GatewayRequest,
  ): Promise<GatewayResponse> {
    let body: unknown;
    try {
      body = JSON.parse(request.body);
    } catch {
      return errorResponse(
        anthropicError('invalid_request_error', 'Request body is not JSON'),
      );
    }
    const model = (body as { model?: unknown }).model;
    if (typeof model !== 'string') {
      return errorResponse(
        anthropicError('invalid_request_error', 'Missing "model"'),
      );
    }

    const resolved = resolveModel(model, {
      overrides: this.deps.config.models.overrides,
    });
    if (!resolved) {
      return errorResponse(
        anthropicError('invalid_request_error', `Unknown model "${model}"`),
      );
    }
    if (resolved.provider !== 'anthropic') {
      return errorResponse(
        anthropicError(
          'invalid_request_error',
          `count_tokens is only supported for Anthropic models, ` +
            `not "${model}" (provider "${resolved.provider}")`,
        ),
      );
    }
    if (!this.deps.registry.has('anthropic')) {
      return errorResponse(
        anthropicError('not_found_error', 'Anthropic provider not configured'),
      );
    }

    const adapter = this.deps.registry.get('anthropic');
    // Reuse the adapter's authed serialization for /messages, then retarget the
    // path to the count_tokens endpoint.
    const serialized = adapter.serializeRequest({
      model: resolved.model,
      stream: false,
      body: { ...(body as Record<string, unknown>), model: resolved.model },
      headers: request.headers,
      upstreamProtocol: 'anthropic',
    });
    let transportResponse;
    try {
      transportResponse = await this.transport(
        { ...serialized, url: `${serialized.url}/count_tokens` },
        { signal: request.signal },
      );
    } catch (cause) {
      const category: ErrorCategory = request.signal?.aborted
        ? 'client_cancelled'
        : adapter.classifyError({ cause });
      return errorResponse(
        anthropicError(
          categoryToAnthropicError(category),
          'Upstream count_tokens request failed',
        ),
      );
    }
    const outHeaders: Record<string, string> = {
      'content-type': 'application/json',
    };
    const requestId =
      transportResponse.headers['request-id'] ??
      transportResponse.headers['anthropic-request-id'];
    if (requestId) {
      outHeaders['request-id'] = requestId;
    }
    return {
      status: transportResponse.status,
      headers: outHeaders,
      body: transportResponse.body,
    };
  }

  /**
   * OpenAI Responses `POST /v1/responses` (epic AIPP-7). Serves Codex and
   * OpenAI-SDK Responses clients: a provider that speaks the Responses protocol
   * natively (OpenAI) is forwarded verbatim; a chat-protocol upstream is served
   * by translating the request to Chat Completions and reconstructing a
   * Responses object/stream. Function tools go through the shared tool router;
   * hosted tools pass through only to a direct OpenAI upstream that runs them.
   */
  private async handleResponses(
    request: GatewayRequest,
  ): Promise<GatewayResponse> {
    const parsed = parseResponsesRequest(request.body);
    if (!parsed.ok) {
      return responsesErrorResponse(parsed.status, parsed.error);
    }

    const resolved = resolveModel(parsed.request.model, {
      overrides: this.deps.config.models.overrides,
    });
    if (!resolved) {
      return responsesErrorResponse(
        400,
        responsesError(
          'invalid_request_error',
          `Unknown model "${parsed.request.model}"`,
          { param: 'model' },
        ),
      );
    }

    const sessionId = header(request.headers, 'x-claude-code-session-id');
    const ctx = new RequestContext(
      {
        clientProtocol: 'openai_responses',
        requestedModel: parsed.request.model,
        sessionId,
        streaming: parsed.request.stream,
      },
      { clock: this.deps.clock, genId: this.deps.genId },
    );

    let adapter: ProviderAdapter;
    try {
      adapter = this.deps.registry.get(resolved.provider);
    } catch (err) {
      if (err instanceof ProviderRegistryError) {
        const attempt = ctx.startAttempt({
          provider: resolved.provider,
          upstreamProtocol: 'unknown',
          routedModel: resolved.model,
          nativeModel: resolved.model,
        });
        attempt.complete('internal_error');
        ctx.complete('internal_error');
        this.emit(ctx, attempt, {
          success: false,
          outcome: 'capability_unsupported',
        });
        return responsesErrorResponse(
          404,
          responsesError('not_found_error', err.message),
        );
      }
      throw err;
    }

    // A provider that speaks the Responses protocol natively is forwarded
    // verbatim; otherwise translate to Chat Completions.
    const native = adapter.upstreamProtocols.includes('openai_responses');
    const attempt = ctx.startAttempt({
      provider: resolved.provider,
      upstreamProtocol: native ? 'openai_responses' : 'openai_chat',
      routedModel: resolved.model,
      nativeModel: resolved.model,
    });

    // Tool-router authorization on the requested function tools (FR-TOOLS-008).
    let toolsDeniedHeader: string | undefined;
    const requestedTools = responsesRequestedToolNames(parsed.request);
    if (requestedTools.length > 0) {
      const decision = decideToolEnforcement(
        this.toolAuthorizer,
        request.headers,
        sessionId ?? '',
        requestedTools,
      );
      if (decision.action === 'reject') {
        attempt.complete('policy_rejected');
        ctx.complete('policy_rejected');
        this.emit(ctx, attempt, { success: false, outcome: 'policy_rejected' });
        return responsesErrorResponse(
          403,
          responsesError(
            'permission_error',
            'All requested tools are denied by the active tool pack policy ' +
              `(denied: ${decision.result.deniedHeader}).`,
            { param: 'tools', code: 'tools_denied' },
          ),
        );
      }
      if (decision.action === 'strip') {
        stripDeniedFunctionTools(
          parsed.request,
          new Set(decision.result.allowed),
        );
        toolsDeniedHeader = decision.result.deniedHeader;
      }
    }

    // Hosted tools: pass through only to a direct OpenAI upstream that runs them
    // and only when configured as allowed; otherwise a capability error.
    const hosted = decideHostedTools(parsed.request.hostedTools, {
      upstreamProvider: resolved.provider,
      allowedHostedTools:
        this.deps.config.protocols.openaiResponses.allowedHostedTools,
    });
    if (hosted.action === 'reject') {
      attempt.complete('validation_error');
      ctx.complete('validation_error');
      this.emit(ctx, attempt, {
        success: false,
        outcome: 'capability_unsupported',
      });
      return responsesErrorResponse(hosted.status, hosted.error);
    }

    const providerRequest: CanonicalProviderRequest = native
      ? {
          model: resolved.model,
          stream: parsed.request.stream,
          body: { ...parsed.request.raw, model: resolved.model },
          headers: request.headers,
          upstreamProtocol: 'openai_responses',
        }
      : {
          model: resolved.model,
          stream: parsed.request.stream,
          body: responsesToChatBody(parsed.request, resolved.model, {
            provider: resolved.provider,
            reasoningCapable: adapter.capabilities.reasoning,
            toolsCapable: adapter.capabilities.tools,
          }) as unknown as Record<string, unknown>,
          headers: request.headers,
          upstreamProtocol: 'openai_chat',
        };

    let transportResponse;
    try {
      transportResponse = await this.transport(
        adapter.serializeRequest(providerRequest),
        { signal: request.signal },
      );
    } catch (cause) {
      const category: ErrorCategory = request.signal?.aborted
        ? 'client_cancelled'
        : adapter.classifyError({ cause });
      attempt.complete(categoryToTerminalState(category));
      ctx.complete(categoryToTerminalState(category));
      this.emit(ctx, attempt, { success: false, outcome: category });
      const mapped = categoryToResponsesError(category);
      return responsesErrorResponse(
        mapped.status,
        responsesError(mapped.type, 'Upstream request failed'),
      );
    }

    const parsedResponse = adapter.parseResponse(transportResponse);

    if (transportResponse.status < 200 || transportResponse.status >= 300) {
      const category = adapter.classifyError({
        status: transportResponse.status,
        body: parsedResponse.body,
      });
      attempt.complete(
        categoryToTerminalState(category),
        transportResponse.status,
      );
      ctx.complete(categoryToTerminalState(category));
      this.emit(ctx, attempt, {
        success: false,
        outcome: category,
        httpStatus: transportResponse.status,
        providerRequestId: parsedResponse.providerRequestId,
        usage: parsedResponse.usage,
      });
      const mapped = categoryToResponsesError(category);
      return responsesErrorResponse(
        mapped.status,
        responsesError(
          mapped.type,
          `Upstream error ${transportResponse.status}`,
        ),
      );
    }

    attempt.complete('success', transportResponse.status);
    ctx.complete('success');
    this.emit(ctx, attempt, {
      success: true,
      outcome: 'success',
      httpStatus: transportResponse.status,
      providerRequestId: parsedResponse.providerRequestId,
      providerResponseId: parsedResponse.providerResponseId,
      stopReason: parsedResponse.stopReason,
      usage: parsedResponse.usage,
    });

    const outHeaders: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (parsedResponse.providerRequestId) {
      outHeaders['request-id'] = parsedResponse.providerRequestId;
    }
    if (toolsDeniedHeader) {
      outHeaders['x-aipp-tools-denied'] = toolsDeniedHeader;
    }

    // Native upstream: forward the Responses body verbatim (object or SSE).
    if (native) {
      if (parsed.request.stream) {
        outHeaders['content-type'] = 'text/event-stream';
      }
      return { status: 200, headers: outHeaders, body: transportResponse.body };
    }

    // Chat upstream: reconstruct a canonical result, then render the object or
    // synthesize the streaming transcript from it.
    const result = chatResponseToCanonical(parsedResponse.body, resolved.model);
    const echo = buildResponsesEcho(parsed.request);
    if (parsed.request.stream) {
      outHeaders['content-type'] = 'text/event-stream';
      const sse = encodeResponsesStream(streamEventsForResult(result), {
        genId: this.deps.genId,
        now: this.deps.now,
        echo,
      });
      return { status: 200, headers: outHeaders, body: sse };
    }
    const obj = buildResponsesObject(result, {
      genId: this.deps.genId,
      now: this.deps.now,
      echo,
    });
    return { status: 200, headers: outHeaders, body: JSON.stringify(obj) };
  }

  /**
   * OpenAI Chat Completions `POST /v1/chat/completions` (epic AIPP-8). Serves
   * OpenAI-SDK chat clients across upstreams: a provider that speaks Chat
   * Completions natively (OpenAI and the OpenAI-compatible providers) is
   * forwarded verbatim; an Anthropic upstream is served by translating the
   * request to Messages and reconstructing a chat.completion, with the cache-
   * token and thinking-diagnostic fixes (subtask 8.2).
   */
  private async handleChat(request: GatewayRequest): Promise<GatewayResponse> {
    const parsed = parseChatRequest(request.body);
    if (!parsed.ok) {
      return chatErrorResponse(parsed.status, parsed.error);
    }

    const resolved = resolveModel(parsed.request.model, {
      overrides: this.deps.config.models.overrides,
    });
    if (!resolved) {
      return chatErrorResponse(
        400,
        chatError(
          'invalid_request_error',
          `Unknown model "${parsed.request.model}"`,
          { param: 'model' },
        ),
      );
    }

    const sessionId = header(request.headers, 'x-claude-code-session-id');
    const ctx = new RequestContext(
      {
        clientProtocol: 'openai_chat',
        requestedModel: parsed.request.model,
        sessionId,
        streaming: parsed.request.stream,
      },
      { clock: this.deps.clock, genId: this.deps.genId },
    );

    let adapter: ProviderAdapter;
    try {
      adapter = this.deps.registry.get(resolved.provider);
    } catch (err) {
      if (err instanceof ProviderRegistryError) {
        const attempt = ctx.startAttempt({
          provider: resolved.provider,
          upstreamProtocol: 'unknown',
          routedModel: resolved.model,
          nativeModel: resolved.model,
        });
        attempt.complete('internal_error');
        ctx.complete('internal_error');
        this.emit(ctx, attempt, {
          success: false,
          outcome: 'capability_unsupported',
        });
        return chatErrorResponse(
          404,
          chatError('not_found_error', err.message),
        );
      }
      throw err;
    }

    // Native chat upstream (OpenAI + OpenAI-compatible) is forwarded verbatim;
    // an Anthropic upstream is translated.
    const chatNative = adapter.upstreamProtocols.includes('openai_chat');
    const attempt = ctx.startAttempt({
      provider: resolved.provider,
      upstreamProtocol: chatNative ? 'openai_chat' : 'anthropic',
      routedModel: resolved.model,
      nativeModel: resolved.model,
    });

    // Tool-router authorization on the requested function tools (FR-TOOLS-008).
    let toolsDeniedHeader: string | undefined;
    const requestedTools = requestedChatToolNames(parsed.request.tools);
    if (requestedTools.length > 0) {
      const decision = decideToolEnforcement(
        this.toolAuthorizer,
        request.headers,
        sessionId ?? '',
        requestedTools,
      );
      if (decision.action === 'reject') {
        attempt.complete('policy_rejected');
        ctx.complete('policy_rejected');
        this.emit(ctx, attempt, { success: false, outcome: 'policy_rejected' });
        return chatErrorResponse(
          403,
          chatError(
            'permission_error',
            'All requested tools are denied by the active tool pack policy ' +
              `(denied: ${decision.result.deniedHeader}).`,
            { param: 'tools', code: 'tools_denied' },
          ),
        );
      }
      if (decision.action === 'strip') {
        stripDeniedChatTools(parsed.request, new Set(decision.result.allowed));
        toolsDeniedHeader = decision.result.deniedHeader;
      }
    }

    const providerRequest: CanonicalProviderRequest = chatNative
      ? {
          model: resolved.model,
          stream: parsed.request.stream,
          body: { ...parsed.request.raw, model: resolved.model },
          headers: request.headers,
          upstreamProtocol: 'openai_chat',
        }
      : {
          model: resolved.model,
          stream: parsed.request.stream,
          body: chatToAnthropicRequest(
            parsed.request,
            resolved.model,
          ) as unknown as Record<string, unknown>,
          headers: request.headers,
          upstreamProtocol: 'anthropic',
        };

    let transportResponse;
    try {
      transportResponse = await this.transport(
        adapter.serializeRequest(providerRequest),
        { signal: request.signal },
      );
    } catch (cause) {
      const category: ErrorCategory = request.signal?.aborted
        ? 'client_cancelled'
        : adapter.classifyError({ cause });
      attempt.complete(categoryToTerminalState(category));
      ctx.complete(categoryToTerminalState(category));
      this.emit(ctx, attempt, { success: false, outcome: category });
      const mapped = categoryToChatError(category);
      return chatErrorResponse(
        mapped.status,
        chatError(mapped.type, 'Upstream request failed'),
      );
    }

    const parsedResponse = adapter.parseResponse(transportResponse);

    if (transportResponse.status < 200 || transportResponse.status >= 300) {
      const category = adapter.classifyError({
        status: transportResponse.status,
        body: parsedResponse.body,
      });
      attempt.complete(
        categoryToTerminalState(category),
        transportResponse.status,
      );
      ctx.complete(categoryToTerminalState(category));
      this.emit(ctx, attempt, {
        success: false,
        outcome: category,
        httpStatus: transportResponse.status,
        providerRequestId: parsedResponse.providerRequestId,
        usage: parsedResponse.usage,
      });
      const mapped = categoryToChatError(category);
      return chatErrorResponse(
        mapped.status,
        chatError(mapped.type, `Upstream error ${transportResponse.status}`),
      );
    }

    attempt.complete('success', transportResponse.status);
    ctx.complete('success');
    this.emit(ctx, attempt, {
      success: true,
      outcome: 'success',
      httpStatus: transportResponse.status,
      providerRequestId: parsedResponse.providerRequestId,
      providerResponseId: parsedResponse.providerResponseId,
      stopReason: parsedResponse.stopReason,
      usage: parsedResponse.usage,
    });

    const outHeaders: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (parsedResponse.providerRequestId) {
      outHeaders['request-id'] = parsedResponse.providerRequestId;
    }
    if (toolsDeniedHeader) {
      outHeaders['x-aipp-tools-denied'] = toolsDeniedHeader;
    }

    // Native upstream: forward the chat body verbatim (object or SSE).
    if (chatNative) {
      if (parsed.request.stream) {
        outHeaders['content-type'] = 'text/event-stream';
      }
      return { status: 200, headers: outHeaders, body: transportResponse.body };
    }

    // Anthropic upstream: reconstruct a chat.completion, surfacing cache tokens
    // (fix 1) and diagnosing dropped thinking blocks (fix 2).
    const { result, diagnostics } = anthropicResponseToChat(
      parsedResponse.body,
      resolved.model,
    );
    if (diagnostics.length > 0) {
      outHeaders['x-aipp-thinking-diagnostics'] = diagnostics
        .map((d) => `${d.kind}=${d.count}`)
        .join(', ');
    }
    if (parsed.request.stream) {
      outHeaders['content-type'] = 'text/event-stream';
      const sse = encodeChatStream(streamEventsForChatResult(result), {
        genId: this.deps.genId,
        now: this.deps.now,
      });
      return { status: 200, headers: outHeaders, body: sse };
    }
    const obj = buildChatCompletion(result, {
      genId: this.deps.genId,
      now: this.deps.now,
    });
    return { status: 200, headers: outHeaders, body: JSON.stringify(obj) };
  }

  /** Start a node:http server bound to the configured host/port. */
  async listen(): Promise<{ host: string; port: number }> {
    const { host, port } = this.deps.config.server;
    this.server = createServer((req, res) => {
      // Abort the upstream request if the client hangs up before we respond.
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          controller.abort();
        }
      });
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        void this.handle({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers as Record<string, string>,
          body,
          signal: controller.signal,
        }).then((response) => {
          if (res.writableEnded || controller.signal.aborted) {
            return; // client already gone; nothing to write
          }
          res.writeHead(response.status, response.headers);
          res.end(response.body);
        });
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(port, host, resolve),
    );
    const address = this.server.address() as AddressInfo | null;
    return { host, port: address?.port ?? port };
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
  }
}

/** Construct a gateway. */
export function createGateway(deps: GatewayDeps): Gateway {
  return new Gateway(deps);
}
