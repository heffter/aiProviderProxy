/**
 * Routing engine (epic AIPP-10, subtask 10.1; FR-ROUTE-001/002, FR-MODEL-006).
 *
 * Turns a surface-agnostic {@link RoutingRequest} into a {@link RoutingDecision}:
 * an ordered candidate list (primary + capability-filtered fallbacks) plus a
 * decision record (requested model, selected model/provider, policy name, and
 * reason) that the server copies onto the lifecycle Attempt so every hop is
 * observable.
 *
 * Modes are ported from the legacy proxy onto canonical requests:
 * - `passthrough` / `standard`: resolve the requested model, single candidate.
 * - `complexity` / `auto`: classify the prompt and select a per-tier model from
 *   `routing.complexity.{simple,moderate,complex}` when configured.
 * - `cascade`: build a same-surface escalation chain from `routing.cascade.models`.
 *
 * Candidate filtering is capability-PRESERVING: a fallback is dropped only when
 * the model registry KNOWS it lacks a required capability. An unregistered model
 * (unknown capabilities) is never dropped -- the engine does not over-filter, and
 * the primary selection is never removed (capability-preserving substitution of
 * the primary is a later subtask). This preserves the anti-misroute guarantee
 * without pruning models we simply have no capability data for.
 */

import type { Config } from '../config/schema.js';
import type { CapabilityName } from '../models/capabilities.js';
import type { ModelRecord, ModelRegistry } from '../models/registry.js';
import { resolveModel, type ResolvedModel } from '../models/aliases.js';
import {
  classifyComplexity,
  type ClassifierMessage,
  type Complexity,
} from './complexity.js';
import {
  crossProviderCandidates,
  type ModelFamilyMapping,
} from './cross-provider.js';

/** The routing sub-config (`config.routing`). */
export type RoutingConfig = Config['routing'];

/** A resolvable model selection: a native id sent to a provider. */
export interface RoutingCandidate {
  provider: string;
  /** Native (upstream) model id to dispatch. */
  model: string;
  /** The routed model label (equals {@link model} today). */
  routedModel: string;
}

/** A surface-agnostic request the engine routes. */
export interface RoutingRequest {
  /** The model the client asked for (pre-resolution). */
  requestedModel: string;
  /** Normalized messages, used only by the complexity classifier. */
  messages: ClassifierMessage[];
  /** Capabilities the request needs (tools/reasoning/vision/...). */
  requiredCapabilities: CapabilityName[];
}

/** The routing decision: an ordered candidate list plus a decision record. */
export interface RoutingDecision {
  requestedModel: string;
  /** The selected candidate (attempt 0). */
  primary: RoutingCandidate;
  /** Ordered fallback candidates (capability-filtered); may be empty. */
  fallbacks: RoutingCandidate[];
  /** Active policy/mode name -> `attempt.routing.policy`. */
  policy: string;
  /** Human-readable selection reason -> `attempt.routing.reason`. */
  reason: string;
  /** Classified complexity, when a complexity-aware mode ran. */
  complexity?: Complexity;
  /** Policy asked this selection never be downgraded (epic AIPP-10, 10.5). */
  neverDowngrade?: boolean;
}

/** A model resolver (injected for tests); defaults to {@link resolveModel}. */
export type ModelResolver = (
  name: string,
  options?: {
    overrides?: Record<string, string>;
    warn?: (message: string) => void;
  },
) => ResolvedModel | null;

/** Dependencies for {@link planRoute}. */
export interface RoutePlannerContext {
  routing: RoutingConfig;
  overrides?: Record<string, string>;
  registry: ModelRegistry;
  resolve?: ModelResolver;
  /** Surface alias-deprecation warnings (e.g. rp:/relayplane:) to the caller. */
  warn?: (message: string) => void;
}

function toCandidate(resolved: ResolvedModel): RoutingCandidate {
  return {
    provider: resolved.provider,
    model: resolved.model,
    routedModel: resolved.model,
  };
}

/** Coerce a config model entry (string alias or `{provider,model}`) to a selection. */
function coerceModel(
  entry: unknown,
  resolve: ModelResolver,
  overrides?: Record<string, string>,
): ResolvedModel | null {
  if (!entry) {
    return null;
  }
  if (typeof entry === 'string') {
    return resolve(entry, { overrides });
  }
  if (typeof entry === 'object') {
    const o = entry as { provider?: string; model?: string };
    if (o.provider && o.model) {
      return { provider: o.provider, model: o.model };
    }
    if (o.model) {
      return resolve(o.model, { overrides });
    }
  }
  return null;
}

/** The configured model for a complexity tier, or null when unmapped. */
function complexityTierModel(
  routing: RoutingConfig,
  label: Complexity,
  resolve: ModelResolver,
  overrides?: Record<string, string>,
): ResolvedModel | null {
  const cfg = routing.complexity as Partial<Record<Complexity, unknown>>;
  return coerceModel(cfg[label], resolve, overrides);
}

/** The configured same-surface cascade chain (may be empty). */
function cascadeChain(
  routing: RoutingConfig,
  resolve: ModelResolver,
  overrides?: Record<string, string>,
): ResolvedModel[] {
  const cfg = routing.cascade as { models?: unknown };
  const list = Array.isArray(cfg.models) ? cfg.models : [];
  const out: ResolvedModel[] = [];
  for (const item of list) {
    const m = coerceModel(item, resolve, overrides);
    if (m) {
      out.push(m);
    }
  }
  return out;
}

/**
 * True when the registry KNOWS this model lacks one of the required
 * capabilities. An unregistered model (undefined record) or any state other than
 * `unsupported` returns false -- the engine never excludes a model it has no
 * capability data for.
 */
export function knownUnsupported(
  record: ModelRecord | undefined,
  required: CapabilityName[],
): boolean {
  if (!record) {
    return false;
  }
  return required.some((cap) => record.capabilities[cap] === 'unsupported');
}

/** Drop candidates the registry knows cannot satisfy the required capabilities. */
export function filterByCapabilities(
  candidates: RoutingCandidate[],
  required: CapabilityName[],
  registry: ModelRegistry,
): RoutingCandidate[] {
  if (required.length === 0) {
    return candidates;
  }
  return candidates.filter(
    (c) => !knownUnsupported(registry.get(c.model), required),
  );
}

/**
 * Plan the route for a request. Returns null when the requested model cannot be
 * resolved at all (the caller surfaces the same unknown-model error it does
 * today); otherwise a {@link RoutingDecision} whose primary is always populated.
 */
export function planRoute(
  req: RoutingRequest,
  ctx: RoutePlannerContext,
): RoutingDecision | null {
  const resolve = ctx.resolve ?? resolveModel;
  const base = resolve(req.requestedModel, {
    overrides: ctx.overrides,
    warn: ctx.warn,
  });
  if (!base) {
    return null;
  }

  const mode = ctx.routing.mode;
  let primary = toCandidate(base);
  let fallbacks: RoutingCandidate[] = [];
  let reason: string = mode;
  let complexity: Complexity | undefined;

  if (mode === 'complexity' || mode === 'auto') {
    const result = classifyComplexity(req.messages);
    complexity = result.complexity;
    const tier = complexityTierModel(
      ctx.routing,
      result.complexity,
      resolve,
      ctx.overrides,
    );
    if (tier) {
      primary = toCandidate(tier);
      reason = `${mode}:${result.complexity}`;
    } else {
      reason = `${mode}:${result.complexity}:unmapped`;
    }
  } else if (mode === 'cascade') {
    const chain = cascadeChain(ctx.routing, resolve, ctx.overrides);
    if (chain.length > 0) {
      primary = toCandidate(chain[0]);
      fallbacks = chain.slice(1).map(toCandidate);
      reason = 'cascade';
    } else {
      reason = 'cascade:unconfigured';
    }
  }

  // Cross-provider fallback (FR-ROUTE-003/010): when enabled, append
  // capability-preserving candidates on other providers that have an explicit
  // family mapping. Disabled by default (behaviour can materially change).
  const xcascade = ctx.routing.crossProviderCascade as {
    enabled?: boolean;
    providers?: string[];
    modelMapping?: ModelFamilyMapping;
  };
  if (xcascade.enabled && (xcascade.providers?.length ?? 0) > 0) {
    const seen = new Set(
      [primary, ...fallbacks].map((c) => `${c.provider}:${c.model}`),
    );
    for (const candidate of crossProviderCandidates(primary, {
      providers: xcascade.providers ?? [],
      requiredCapabilities: req.requiredCapabilities,
      registry: ctx.registry,
      custom: xcascade.modelMapping,
    })) {
      const key = `${candidate.provider}:${candidate.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        fallbacks.push(candidate);
      }
    }
  }

  // Capability-preserving filter over the fallback chain (FR-ROUTE-001,
  // FR-MODEL-006). The primary is never removed here.
  fallbacks = filterByCapabilities(
    fallbacks,
    req.requiredCapabilities,
    ctx.registry,
  );

  return {
    requestedModel: req.requestedModel,
    primary,
    fallbacks,
    policy: mode,
    reason,
    complexity,
  };
}

/** Build the required-capability list from request feature flags. */
export function requiredCapabilitiesFor(flags: {
  tools?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  streaming?: boolean;
}): CapabilityName[] {
  const caps: CapabilityName[] = [];
  if (flags.tools) caps.push('tools');
  if (flags.reasoning) caps.push('reasoning');
  if (flags.vision) caps.push('vision');
  if (flags.streaming) caps.push('streaming');
  return caps;
}
