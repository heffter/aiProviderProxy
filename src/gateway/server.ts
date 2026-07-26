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
