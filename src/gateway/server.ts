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
import { buildModelRegistry } from '../models/builtin.js';
import type { ModelRegistry } from '../models/registry.js';
import {
  planRoute,
  normalizeMessages,
  requiredCapabilitiesFor,
  checkDowngrade,
  applyDowngradeHeaders,
  isReliabilityStatus,
  isReliabilityCategory,
  DEFAULT_DOWNGRADE_MAPPING,
  backoffDelayMs,
  shouldPreStreamRetry,
  CooldownManager,
  classifyComplexity,
  resolvePolicy,
  loadPolicyFile,
  type RoutingDecision,
  type FallbackTrigger,
  type RetryPolicy,
  type RoutingPolicy,
} from '../routing/index.js';
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
  chatCompletionToCanonical,
  chatError,
  chatToAnthropicRequest,
  encodeChatStream,
  parseChatRequest,
  streamEventsForChatResult,
  type ChatErrorEnvelope,
  type ChatErrorType,
  type ParsedChatRequest,
} from '../protocols/openai-chat/index.js';
import {
  anthropicThinkingToGlm,
  extractGlmReasoningContent,
  glmReasoningToAnthropicBlock,
} from '../providers/zai/index.js';
import { ToolAuthorizer, decideToolEnforcement } from '../tools/index.js';
import type { BudgetManager } from '../ops/budget/index.js';
import {
  EstimateRateLimiter,
  estimateChat,
  listModels,
} from './openai-endpoints.js';
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
  /** Model registry for capability-aware routing; defaults to the built-ins. */
  modelRegistry?: ModelRegistry;
  /**
   * Current budget utilisation percent (0-100+), consulted for budget
   * downgrade. Defaults to the injected {@link budget} ledger's daily percent,
   * else 0 (never downgrades).
   */
  budgetPercent?: () => number;
  /**
   * The unified budget ledger. When present and enabled, a breaching pre-request
   * check with a `block` action rejects the request with a budget_exceeded
   * outcome; its daily percent also feeds the downgrade seam by default.
   */
  budget?: BudgetManager;
  /**
   * Ordered account labels available for a provider, used for token-pool
   * account rotation on an auth failure. Defaults to none (no rotation). The
   * real token-pool source is wired in a later subtask.
   */
  accountsFor?: (provider: string) => string[];
  /** Backoff sleep (injected for deterministic retry tests). */
  sleep?: (ms: number) => Promise<void>;
  /** RNG for retry jitter (injected for deterministic retry tests). */
  random?: () => number;
  /** Provider cooldown breaker; defaults to one built from `config.routing.cooldown`. */
  cooldown?: CooldownManager;
  /**
   * Agent-routing policy for live enforcement. When omitted and
   * `routing.policy.enforce` is set, it is loaded from `<home>/policy.yaml`.
   * Pass `null` to disable enforcement even when the flag is on.
   */
  routingPolicy?: RoutingPolicy | null;
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

/** One planned upstream attempt: a resolved provider/model plus its linkage. */
interface RoutingHop {
  provider: string;
  model: string;
  accountLabel?: string;
  /** Model this hop falls back FROM (set for non-primary hops). */
  fallbackFrom?: string;
  /** Why this hop exists (downgrade/reliability/rotation); unset for the primary. */
  fallbackTrigger?: FallbackTrigger;
  /** Same-model pre-stream retries already spent on this candidate. */
  retryCount?: number;
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
  private readonly modelRegistry: ModelRegistry;
  private readonly cooldown: CooldownManager;
  private readonly routingPolicy: RoutingPolicy | null;
  private readonly estimateLimiter: EstimateRateLimiter;
  private server?: Server;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.transport = deps.transport ?? httpTransport;
    this.toolAuthorizer =
      deps.toolAuthorizer ?? new ToolAuthorizer(deps.config.tools);
    this.modelRegistry = deps.modelRegistry ?? buildModelRegistry();
    const cd = deps.config.routing.cooldown;
    this.cooldown =
      deps.cooldown ??
      new CooldownManager(
        {
          enabled: cd.enabled,
          allowedFails: cd.allowedFails,
          windowSeconds: cd.windowSeconds,
          cooldownSeconds: cd.cooldownSeconds,
        },
        { now: deps.now },
      );
    // Load the agent-routing policy only when enforcement is on and none was
    // injected. A missing/invalid file yields null (enforcement is inert).
    this.routingPolicy =
      deps.routingPolicy !== undefined
        ? deps.routingPolicy
        : deps.config.routing.policy.enforce
          ? loadPolicyFile()
          : null;
    this.estimateLimiter = new EstimateRateLimiter({ now: deps.now });
  }

  /**
   * Plan the route for a request: resolve the requested model to a provider and
   * an ordered candidate list under the active routing mode. Returns null when
   * the requested model cannot be resolved at all (the caller surfaces the same
   * unknown-model error it did before routing existed). The request body is read
   * defensively so this works across all three surfaces (`messages` for
   * Anthropic/Chat, `input` for Responses).
   */
  private planRouteFor(
    requestedModel: string,
    raw: unknown,
    warn?: (message: string) => void,
    headers?: Record<string, string>,
  ): RoutingDecision | null {
    const body = (raw ?? {}) as Record<string, unknown>;
    const source = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : [];
    const messages = normalizeMessages(
      source as Array<{ role?: string; content?: unknown }>,
    );
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const hasReasoning =
      body.thinking != null ||
      body.reasoning != null ||
      body.reasoning_effort != null;
    const decision = planRoute(
      {
        requestedModel,
        messages,
        requiredCapabilities: requiredCapabilitiesFor({
          tools: hasTools,
          reasoning: hasReasoning,
        }),
      },
      {
        routing: this.deps.config.routing,
        overrides: this.deps.config.models.overrides,
        registry: this.modelRegistry,
        warn,
      },
    );
    if (decision && this.deps.config.routing.policy.enforce) {
      this.enforcePolicy(decision, messages, headers ?? {});
    }
    return decision;
  }

  /**
   * Apply the agent-routing policy to a decision in place (FR-ROUTE-007/015).
   * A matching rule overrides the primary selection and records the policy name
   * and reason; a `neverDowngrade` rule blocks any later budget downgrade. Agent
   * identity and task type come from request headers. Inert when no policy is
   * loaded or no rule matches.
   */
  private enforcePolicy(
    decision: RoutingDecision,
    messages: Array<{ role: string; text: string }>,
    headers: Record<string, string>,
  ): void {
    if (!this.routingPolicy) {
      return;
    }
    const candidateModel = `${decision.primary.provider}/${decision.primary.model}`;
    const complexity =
      decision.complexity ?? classifyComplexity(messages).complexity;
    const resolution = resolvePolicy(
      this.routingPolicy,
      header(headers, 'x-aipp-agent-fingerprint'),
      header(headers, 'x-aipp-agent'),
      header(headers, 'x-aipp-task-type') ?? 'general',
      complexity,
      candidateModel,
    );
    decision.neverDowngrade = resolution.neverDowngrade;
    if (resolution.model === candidateModel) {
      return;
    }
    const resolved = resolveModel(resolution.model, {
      overrides: this.deps.config.models.overrides,
    });
    if (!resolved) {
      return; // unknown policy target: leave the mode selection untouched
    }
    decision.primary = {
      provider: resolved.provider,
      model: resolved.model,
      routedModel: resolved.model,
    };
    decision.policy = `policy:${resolution.resolvedBy}`;
    decision.reason = resolution.reason;
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
    if (request.method === 'GET' && path === '/v1/models') {
      return json(200, listModels());
    }
    if (request.method === 'POST' && path === '/v1/estimate') {
      return this.handleEstimate(request);
    }
    return errorResponse(
      anthropicError(
        'not_found_error',
        `No route for ${request.method} ${path}`,
      ),
    );
  }

  private emitEvent(
    kind: 'attempt' | 'logical_request',
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
      eventKind: kind,
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
      if (kind === 'attempt') {
        this.deps.sinks?.emitAttemptFinal(event);
      } else {
        this.deps.sinks?.emitLogicalRequestFinal(event);
      }
      this.deps.outbox?.enqueue(event);
    } catch {
      // telemetry is best-effort and must never affect the response
    }
  }

  /** Emit the terminal event for a logical request (winner or final error). */
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
    this.emitEvent('logical_request', ctx, attempt, input);
  }

  /** Emit an event for a non-winning (superseded) fallback attempt. */
  private emitAttempt(
    ctx: RequestContext,
    attempt: RequestContext['attempts'][number],
    input: {
      success: boolean;
      outcome: string;
      httpStatus?: number;
      providerRequestId?: string;
      usage?: ProviderUsage;
    },
  ): void {
    this.emitEvent('attempt', ctx, attempt, input);
  }

  /** Current budget utilisation percent (ledger daily percent, else 0). */
  private budgetPercent(): number {
    if (this.deps.budgetPercent) {
      return this.deps.budgetPercent();
    }
    return this.deps.budget?.dailyPercent() ?? 0;
  }

  /** Ordered account labels for a provider (empty when rotation is unavailable). */
  private accountsFor(provider: string): string[] {
    return this.deps.accountsFor?.(provider) ?? [];
  }

  /** Sleep for a backoff interval (injectable for deterministic tests). */
  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) {
      return this.deps.sleep(ms);
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** The active pre-stream retry policy (from config, with defaults). */
  private retryPolicy(): RetryPolicy {
    const r = this.deps.config.routing.retry;
    return {
      maxRetries: r.maxRetries,
      baseDelayMs: r.baseDelayMs,
      maxDelayMs: r.maxDelayMs,
      jitter: r.jitter,
    };
  }

  /**
   * Decide what to do after a failed hop and mutate the work queue accordingly.
   * A same-model pre-stream retry (bounded, backoff, adapter-gated) is preferred
   * for transient connection/timeout failures; otherwise a reliability fallback
   * or account rotation. Returns true when the loop should continue (the failed
   * attempt was superseded), false when the failure is terminal.
   */
  private async advanceAfterFailure(
    category: ErrorCategory,
    httpStatus: number | undefined,
    adapter: ProviderAdapter,
    queue: RoutingHop[],
    hop: RoutingHop,
    accountCursor: Map<string, number>,
  ): Promise<boolean> {
    const retryCount = hop.retryCount ?? 0;
    const policy = this.retryPolicy();
    if (
      shouldPreStreamRetry(category, retryCount, policy, adapter.retrySafety)
    ) {
      // Same-model retry: sleep the backoff, then re-queue this hop. Runs before
      // any client output, so it is always safe (post-stream retry is forbidden).
      await this.sleep(
        backoffDelayMs(retryCount, policy, this.deps.random ?? Math.random),
      );
      queue.unshift({
        ...hop,
        retryCount: retryCount + 1,
        fallbackFrom: hop.model,
        fallbackTrigger: 'reliability',
      });
      return true;
    }
    return this.nextFallbackHop(
      category,
      httpStatus,
      queue,
      hop,
      accountCursor,
    );
  }

  /**
   * Feed a failed attempt to the cooldown breaker, but only for the transient
   * upstream categories that reflect provider health (rate-limit / overload /
   * timeout / connection), never client or validation faults.
   */
  private recordProviderFailure(
    provider: string,
    category: ErrorCategory,
    httpStatus: number | undefined,
  ): void {
    const triggerStatuses =
      this.deps.config.routing.crossProviderCascade.triggerStatuses;
    if (
      isReliabilityCategory(category) ||
      isReliabilityStatus(httpStatus, triggerStatuses)
    ) {
      this.cooldown.recordFailure(provider);
    }
  }

  /**
   * A single planned upstream attempt within a logical request: a resolved
   * provider/model plus the linkage explaining why this attempt exists.
   */
  private nextFallbackHop(
    category: ErrorCategory,
    httpStatus: number | undefined,
    queue: RoutingHop[],
    hop: RoutingHop,
    accountCursor: Map<string, number>,
  ): boolean {
    // Client and validation faults are deterministic: never retry them.
    if (
      category === 'client_cancelled' ||
      category === 'client_validation_error' ||
      category === 'client_auth_error' ||
      category === 'policy_rejected' ||
      category === 'capability_unsupported' ||
      category === 'provider_validation_error' ||
      category === 'budget_exceeded'
    ) {
      return false;
    }
    // Account rotation: on an auth failure, switch to the next account of the
    // SAME provider/model before considering a cross-provider fallback.
    if (category === 'provider_auth_error') {
      const accounts = this.accountsFor(hop.provider);
      const used = accountCursor.get(hop.provider) ?? 0;
      if (used + 1 < accounts.length) {
        accountCursor.set(hop.provider, used + 1);
        queue.unshift({
          provider: hop.provider,
          model: hop.model,
          accountLabel: accounts[used + 1],
          fallbackFrom: hop.model,
          fallbackTrigger: 'rotation',
        });
        return true;
      }
      return false;
    }
    // Reliability fallback: on a transient upstream failure, advance to the next
    // queued candidate and stamp the linkage onto it.
    const triggerStatuses =
      this.deps.config.routing.crossProviderCascade.triggerStatuses;
    if (
      queue.length > 0 &&
      (isReliabilityCategory(category) ||
        isReliabilityStatus(httpStatus, triggerStatuses))
    ) {
      queue[0] = {
        ...queue[0],
        fallbackFrom: hop.model,
        fallbackTrigger: 'reliability',
      };
      return true;
    }
    return false;
  }

  private async handleMessages(
    request: GatewayRequest,
  ): Promise<GatewayResponse> {
    const parsed = parseMessagesRequest(request.body);
    if (!parsed.ok) {
      return errorResponse(parsed.error);
    }

    const route = this.planRouteFor(
      parsed.request.model,
      parsed.request.raw,
      undefined,
      request.headers,
    );
    if (!route) {
      return errorResponse(
        anthropicError(
          'invalid_request_error',
          `Unknown model "${parsed.request.model}"`,
        ),
      );
    }
    const resolved = route.primary;

    const ctx = new RequestContext(
      {
        clientProtocol: 'anthropic_messages',
        requestedModel: parsed.request.model,
        sessionId: header(request.headers, 'x-claude-code-session-id'),
        streaming: parsed.request.stream,
      },
      { clock: this.deps.clock, genId: this.deps.genId },
    );

    // Budget downgrade: swap the primary model for a cheaper one when the budget
    // threshold is crossed. The swap is a distinct, header-marked routing event
    // (fallbackTrigger 'downgrade'), not a post-failure hop. A policy that pins
    // the model (neverDowngrade) suppresses it (FR-ROUTE-015).
    const dgCfg = this.deps.config.routing.downgrade;
    const downgrade = route.neverDowngrade
      ? checkDowngrade(resolved.model, 0, {
          enabled: false,
          thresholdPercent: 100,
          mapping: {},
        })
      : checkDowngrade(resolved.model, this.budgetPercent(), {
          enabled: dgCfg.enabled,
          thresholdPercent: dgCfg.thresholdPercent,
          mapping:
            Object.keys(dgCfg.mapping).length > 0
              ? dgCfg.mapping
              : DEFAULT_DOWNGRADE_MAPPING,
        });

    // Ordered hop queue: the (possibly downgraded) primary, then the
    // capability-filtered cross-provider fallbacks from the routing decision.
    let primaryHop: RoutingHop;
    if (downgrade.downgraded) {
      const re = resolveModel(downgrade.newModel, {
        overrides: this.deps.config.models.overrides,
      }) ?? { provider: resolved.provider, model: downgrade.newModel };
      primaryHop = {
        provider: re.provider,
        model: re.model,
        fallbackFrom: downgrade.originalModel,
        fallbackTrigger: 'downgrade',
      };
    } else {
      primaryHop = { provider: resolved.provider, model: resolved.model };
    }
    const primaryAccounts = this.accountsFor(primaryHop.provider);
    if (primaryAccounts.length > 0) {
      primaryHop.accountLabel = primaryAccounts[0];
    }
    const queue: RoutingHop[] = [
      primaryHop,
      ...route.fallbacks.map((f) => ({ provider: f.provider, model: f.model })),
    ];

    // Budget gate: a breaching pre-request check with a `block` action rejects
    // before any dispatch (budget_exceeded outcome). Other breach actions
    // (warn/downgrade/alert) allow the request through; downgrade is handled by
    // the budgetPercent seam above.
    if (this.deps.budget) {
      const budget = this.deps.budget.check();
      if (!budget.allowed) {
        const attempt = ctx.startAttempt({
          provider: primaryHop.provider,
          upstreamProtocol:
            primaryHop.provider === 'anthropic' ? 'anthropic' : 'openai_chat',
          routedModel: primaryHop.model,
          nativeModel: primaryHop.model,
          routing: this.hopRouting(route, primaryHop),
        });
        attempt.complete('policy_rejected');
        ctx.complete('policy_rejected');
        this.emit(ctx, attempt, { success: false, outcome: 'budget_exceeded' });
        return errorResponse(
          anthropicError(
            'rate_limit_error',
            `Budget exceeded (${budget.breachType} limit); request blocked.`,
          ),
        );
      }
    }

    // Tool authorization runs once (pack policy is provider-agnostic) against a
    // primary attempt so a full denial is recorded and returned before dispatch.
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
        const attempt = ctx.startAttempt({
          provider: primaryHop.provider,
          upstreamProtocol:
            primaryHop.provider === 'anthropic' ? 'anthropic' : 'openai_chat',
          routedModel: primaryHop.model,
          nativeModel: primaryHop.model,
          routing: this.hopRouting(route, primaryHop),
        });
        attempt.complete('policy_rejected');
        ctx.complete('policy_rejected');
        this.emit(ctx, attempt, { success: false, outcome: 'policy_rejected' });
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

    // Attempt loop: dispatch each hop; on a transient failure fall back to the
    // next candidate (reliability) or rotate accounts (rotation), emitting one
    // attempt-final event per superseded hop. The winner (or the final error)
    // emits the logical-request event.
    const accountCursor = new Map<string, number>();
    while (queue.length > 0) {
      const hop = queue.shift() as RoutingHop;
      const routingCtx = this.hopRouting(route, hop);

      // Cooldown: skip a cooling provider without an upstream call. Advance to
      // the next candidate (stamping reliability linkage); if none remain, the
      // request fails with an overloaded error.
      if (!this.cooldown.isAvailable(hop.provider)) {
        if (queue.length > 0) {
          queue[0] = {
            ...queue[0],
            fallbackFrom: hop.model,
            fallbackTrigger: 'reliability',
          };
          continue;
        }
        const attempt = ctx.startAttempt({
          provider: hop.provider,
          upstreamProtocol: 'unknown',
          routedModel: hop.model,
          nativeModel: hop.model,
          routing: routingCtx,
        });
        attempt.complete('upstream_error');
        ctx.complete('upstream_error');
        this.emit(ctx, attempt, {
          success: false,
          outcome: 'provider_overloaded',
        });
        return errorResponse(
          anthropicError(
            'overloaded_error',
            `Provider ${hop.provider} is cooling down after repeated failures`,
          ),
        );
      }

      let adapter: ProviderAdapter;
      try {
        adapter = this.deps.registry.get(hop.provider);
      } catch (err) {
        if (err instanceof ProviderRegistryError) {
          const attempt = ctx.startAttempt({
            provider: hop.provider,
            upstreamProtocol: 'unknown',
            routedModel: hop.model,
            nativeModel: hop.model,
            routing: routingCtx,
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

      const verbatim = hop.provider === 'anthropic';
      const upstreamProtocol = verbatim ? 'anthropic' : 'openai_chat';
      const attempt = ctx.startAttempt({
        provider: hop.provider,
        upstreamProtocol,
        routedModel: hop.model,
        nativeModel: hop.model,
        routing: routingCtx,
      });

      const providerRequest: CanonicalProviderRequest = verbatim
        ? {
            model: hop.model,
            stream: parsed.request.stream,
            body: { ...parsed.request.raw, model: hop.model },
            headers: request.headers,
            upstreamProtocol: 'anthropic',
          }
        : {
            model: hop.model,
            stream: parsed.request.stream,
            body: anthropicToOpenAIRequest(parsed.request, hop.model)
              .body as unknown as Record<string, unknown>,
            headers: request.headers,
            upstreamProtocol: 'openai_chat',
          };

      // GLM (Z.ai) reasoning: map the Anthropic thinking budget onto GLM's
      // thinking / reasoning_effort controls (subtask 9.3).
      if (!verbatim && hop.provider === 'zai') {
        Object.assign(
          providerRequest.body,
          anthropicThinkingToGlm(
            (parsed.request.raw as { thinking?: unknown }).thinking,
          ),
        );
      }

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
        this.recordProviderFailure(hop.provider, category, undefined);
        if (
          await this.advanceAfterFailure(
            category,
            undefined,
            adapter,
            queue,
            hop,
            accountCursor,
          )
        ) {
          this.emitAttempt(ctx, attempt, { success: false, outcome: category });
          continue;
        }
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
        this.recordProviderFailure(
          hop.provider,
          category,
          transportResponse.status,
        );
        if (
          await this.advanceAfterFailure(
            category,
            transportResponse.status,
            adapter,
            queue,
            hop,
            accountCursor,
          )
        ) {
          this.emitAttempt(ctx, attempt, {
            success: false,
            outcome: category,
            httpStatus: transportResponse.status,
            providerRequestId: parsedResponse.providerRequestId,
            usage: parsedResponse.usage,
          });
          continue;
        }
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

      // Success: this hop wins the request.
      attempt.complete('success', transportResponse.status);
      ctx.complete('success');
      this.cooldown.recordSuccess(hop.provider);
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
        : openAIResponseToAnthropic(parsedResponse.body, hop.model);
      // GLM reasoning: surface reasoning_content as a leading (unsigned) thinking
      // block on the translated Anthropic message (subtask 9.3).
      if (!verbatim && hop.provider === 'zai') {
        const block = glmReasoningToAnthropicBlock(
          extractGlmReasoningContent(parsedResponse.body),
        );
        if (block) {
          (responseBody as { content: unknown[] }).content.unshift(block);
        }
      }
      const outHeaders: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (parsedResponse.providerRequestId) {
        outHeaders['request-id'] = parsedResponse.providerRequestId;
      }
      if (toolsDeniedHeader) {
        outHeaders['x-aipp-tools-denied'] = toolsDeniedHeader;
      }
      applyDowngradeHeaders(outHeaders, downgrade);
      return {
        status: 200,
        headers: outHeaders,
        body: JSON.stringify(responseBody),
      };
    }

    // Unreachable: the loop returns on the terminal (last) hop.
    throw new Error('routing exhausted without a terminal response');
  }

  /** Build the lifecycle routing context for one hop of a decision. */
  private hopRouting(
    route: RoutingDecision,
    hop: RoutingHop,
  ): {
    policy: string;
    reason: string;
    fallbackFrom?: string;
    fallbackTrigger?: string;
    accountLabel?: string;
  } {
    return {
      policy: route.policy,
      reason: route.reason,
      fallbackFrom: hop.fallbackFrom,
      fallbackTrigger: hop.fallbackTrigger,
      accountLabel: hop.accountLabel,
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

    const route = this.planRouteFor(
      parsed.request.model,
      parsed.request.raw,
      undefined,
      request.headers,
    );
    if (!route) {
      return responsesErrorResponse(
        400,
        responsesError(
          'invalid_request_error',
          `Unknown model "${parsed.request.model}"`,
          { param: 'model' },
        ),
      );
    }
    const resolved = route.primary;
    const routing = { policy: route.policy, reason: route.reason };

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
          routing,
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
      routing,
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

    // Legacy rp:/relayplane: aliases still resolve, with a deprecation warning
    // surfaced to the client (FR-CHAT-005).
    const deprecations: string[] = [];
    const route = this.planRouteFor(
      parsed.request.model,
      parsed.request.raw,
      (message) => deprecations.push(message),
      request.headers,
    );
    if (!route) {
      return chatErrorResponse(
        400,
        chatError(
          'invalid_request_error',
          `Unknown model "${parsed.request.model}"`,
          { param: 'model' },
        ),
      );
    }
    const resolved = route.primary;
    const routing = { policy: route.policy, reason: route.reason };

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
          routing,
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

    // Routing mode by upstream protocol: a native chat upstream (OpenAI +
    // OpenAI-compatible) is forwarded verbatim; an Anthropic upstream is
    // translated in the protocol layer; every other adapter (Gemini, Ollama)
    // translates internally and presents a chat.completion via parseResponse.
    const upstreamProtocol = adapter.upstreamProtocols[0];
    const chatMode: 'verbatim' | 'anthropic' | 'translating' =
      adapter.upstreamProtocols.includes('openai_chat')
        ? 'verbatim'
        : adapter.upstreamProtocols.includes('anthropic')
          ? 'anthropic'
          : 'translating';
    const attempt = ctx.startAttempt({
      provider: resolved.provider,
      upstreamProtocol,
      routedModel: resolved.model,
      nativeModel: resolved.model,
      routing,
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

    // Translated upstreams (Anthropic, Gemini, Ollama) are reconstructed into a
    // chat.completion and, for streaming clients, re-emitted as a chunk stream;
    // the upstream is therefore always requested non-streaming. A verbatim
    // upstream streams through unchanged.
    const providerRequest: CanonicalProviderRequest =
      chatMode === 'verbatim'
        ? {
            model: resolved.model,
            stream: parsed.request.stream,
            body: { ...parsed.request.raw, model: resolved.model },
            headers: request.headers,
            upstreamProtocol: 'openai_chat',
          }
        : chatMode === 'anthropic'
          ? {
              model: resolved.model,
              stream: false,
              body: chatToAnthropicRequest(
                parsed.request,
                resolved.model,
              ) as unknown as Record<string, unknown>,
              headers: request.headers,
              upstreamProtocol: 'anthropic',
            }
          : {
              model: resolved.model,
              stream: false,
              body: { ...parsed.request.raw, model: resolved.model },
              headers: request.headers,
              upstreamProtocol,
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
    if (deprecations.length > 0) {
      outHeaders['x-aipp-deprecation'] = deprecations.join('; ');
    }

    // Verbatim upstream: forward the chat body unchanged (object or SSE).
    if (chatMode === 'verbatim') {
      if (parsed.request.stream) {
        outHeaders['content-type'] = 'text/event-stream';
      }
      return { status: 200, headers: outHeaders, body: transportResponse.body };
    }

    // Reconstruct a canonical chat result. The Anthropic path additionally
    // surfaces cache tokens (fix 1) and diagnoses dropped thinking blocks
    // (fix 2); Gemini/Ollama adapters already return a chat.completion.
    let result;
    if (chatMode === 'anthropic') {
      const translated = anthropicResponseToChat(
        parsedResponse.body,
        resolved.model,
      );
      result = translated.result;
      if (translated.diagnostics.length > 0) {
        outHeaders['x-aipp-thinking-diagnostics'] = translated.diagnostics
          .map((d) => `${d.kind}=${d.count}`)
          .join(', ');
      }
    } else {
      // Stamp the routed model onto the adapter-produced chat.completion.
      if (parsedResponse.body && typeof parsedResponse.body === 'object') {
        (parsedResponse.body as { model?: string }).model = resolved.model;
      }
      result = chatCompletionToCanonical(parsedResponse.body);
      result.model = resolved.model;
    }

    if (parsed.request.stream) {
      outHeaders['content-type'] = 'text/event-stream';
      const sse = encodeChatStream(streamEventsForChatResult(result), {
        genId: this.deps.genId,
        now: this.deps.now,
      });
      return { status: 200, headers: outHeaders, body: sse };
    }
    // Gemini/Ollama already produced a spec chat.completion; forward it. The
    // Anthropic path renders one from the canonical result.
    if (chatMode === 'anthropic') {
      const obj = buildChatCompletion(result, {
        genId: this.deps.genId,
        now: this.deps.now,
      });
      return { status: 200, headers: outHeaders, body: JSON.stringify(obj) };
    }
    return {
      status: 200,
      headers: outHeaders,
      body: JSON.stringify(parsedResponse.body),
    };
  }

  /**
   * `POST /v1/estimate` (epic AIPP-8). Pre-flight cost estimate from the
   * advisory pricing table; never forwards to a provider. Rate-limited per
   * client to 60/min (legacy parity).
   */
  private handleEstimate(request: GatewayRequest): GatewayResponse {
    const clientKey =
      header(request.headers, 'x-client-id') ??
      header(request.headers, 'x-forwarded-for') ??
      header(request.headers, 'x-claude-code-session-id') ??
      'anonymous';
    const limit = this.estimateLimiter.check(clientKey);
    if (!limit.allowed) {
      return {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(
            Math.ceil((limit.retryAfterMs ?? 60_000) / 1000),
          ),
        },
        body: JSON.stringify(
          chatError(
            'rate_limit_error',
            'Estimate rate limit exceeded (60/min)',
            {
              code: 'rate_limited',
            },
          ),
        ),
      };
    }

    let body: unknown;
    try {
      body = JSON.parse(request.body);
    } catch {
      return chatErrorResponse(
        400,
        chatError('invalid_request_error', 'Request body is not valid JSON'),
      );
    }
    const model = (body as { model?: unknown }).model;
    if (typeof model !== 'string' || model.length === 0) {
      return chatErrorResponse(
        400,
        chatError('invalid_request_error', 'model: Field required', {
          param: 'model',
        }),
      );
    }
    const estimate = estimateChat(body as { model: string }, {
      overrides: this.deps.config.models.overrides,
    });
    if (!estimate) {
      return chatErrorResponse(
        400,
        chatError('invalid_request_error', `Unknown model "${model}"`, {
          param: 'model',
        }),
      );
    }
    return json(200, estimate);
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
