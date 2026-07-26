/**
 * OpenAI-compatible auxiliary endpoints (epic AIPP-8, subtask 8.5;
 * FR-CHAT-005..010): `GET /v1/models` and `POST /v1/estimate`.
 *
 *  - `/v1/models` lists the models a client can request: every registry alias
 *    plus its resolved native id, each tagged with the owning provider.
 *  - `/v1/estimate` returns a pre-flight cost estimate from an advisory pricing
 *    table without forwarding to any provider, rate-limited per client to the
 *    legacy 60 requests/minute.
 *
 * Pricing is advisory (USD per 1M tokens) and token counts use the standard
 * 4-chars-per-token heuristic; both are estimates, not billing figures.
 */

import {
  DEFAULT_SMART_ALIASES,
  MODEL_MAPPING,
  resolveModel,
} from '../models/index.js';

/** One entry in an OpenAI `/v1/models` listing. */
export interface ModelListEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/** Build the `/v1/models` listing from the registry alias map. */
export function listModels(created = 1_700_000_000): {
  object: 'list';
  data: ModelListEntry[];
} {
  const byId = new Map<string, string>();
  const add = (id: string, provider: string): void => {
    if (id.length > 0 && !byId.has(id)) {
      byId.set(id, provider);
    }
  };
  // Aliases and their resolved native ids.
  for (const [alias, resolved] of Object.entries(MODEL_MAPPING)) {
    add(alias, resolved.provider);
    add(resolved.model, resolved.provider);
  }
  for (const [alias, resolved] of Object.entries(DEFAULT_SMART_ALIASES)) {
    add(alias, resolved.provider);
  }
  const data: ModelListEntry[] = [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, provider]) => ({
      id,
      object: 'model',
      created,
      owned_by: provider,
    }));
  return { object: 'list', data };
}

/**
 * Advisory pricing (USD per 1M tokens) keyed by native model id prefix, with a
 * per-provider fallback. Approximate; used only for pre-flight estimates.
 */
const MODEL_PRICING: Array<{
  match: (model: string) => boolean;
  inputPerM: number;
  outputPerM: number;
}> = [
  { match: (m) => m.startsWith('claude-opus'), inputPerM: 15, outputPerM: 75 },
  { match: (m) => m.startsWith('claude-haiku'), inputPerM: 1, outputPerM: 5 },
  {
    match: (m) => m.startsWith('claude-3-5-haiku'),
    inputPerM: 0.8,
    outputPerM: 4,
  },
  { match: (m) => m.startsWith('claude'), inputPerM: 3, outputPerM: 15 },
  {
    match: (m) => m.startsWith('gpt-4o-mini'),
    inputPerM: 0.15,
    outputPerM: 0.6,
  },
  { match: (m) => m.startsWith('gpt-4o'), inputPerM: 2.5, outputPerM: 10 },
  {
    match: (m) => m.startsWith('gpt-5') || m.startsWith('gpt-4.1'),
    inputPerM: 2,
    outputPerM: 8,
  },
  {
    match: (m) => m.startsWith('o3') || m.startsWith('o4'),
    inputPerM: 2,
    outputPerM: 8,
  },
  { match: (m) => m.startsWith('gpt-'), inputPerM: 1, outputPerM: 3 },
  { match: (m) => m.startsWith('gemini'), inputPerM: 1.25, outputPerM: 5 },
  { match: (m) => m.startsWith('grok'), inputPerM: 2, outputPerM: 10 },
];

/** Per-provider fallback pricing (USD per 1M tokens). */
const PROVIDER_PRICING: Record<
  string,
  { inputPerM: number; outputPerM: number }
> = {
  anthropic: { inputPerM: 3, outputPerM: 15 },
  openai: { inputPerM: 1, outputPerM: 3 },
  google: { inputPerM: 1.25, outputPerM: 5 },
  xai: { inputPerM: 2, outputPerM: 10 },
  ollama: { inputPerM: 0, outputPerM: 0 },
};

/** Resolve advisory pricing for a native model id + provider. */
export function pricingFor(
  model: string,
  provider: string,
): { inputPerM: number; outputPerM: number } {
  for (const entry of MODEL_PRICING) {
    if (entry.match(model)) {
      return { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM };
    }
  }
  return PROVIDER_PRICING[provider] ?? { inputPerM: 1, outputPerM: 3 };
}

/** Count tokens with the standard ~4-chars-per-token heuristic. */
export function countTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Count input tokens across chat messages (with per-message overhead). */
export function countMessagesTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) {
    total += 4; // role + structural overhead
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      total += countTextTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') total += countTextTokens(text);
      }
    }
  }
  return total;
}

/** A pre-flight estimate result. */
export interface EstimateResult {
  model: string;
  provider: string;
  input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
  currency: 'USD';
}

const DEFAULT_OUTPUT_MULTIPLIER = 0.5;

/** Estimate the cost of a chat request without forwarding it. */
export function estimateChat(
  body: {
    model: string;
    messages?: unknown;
    max_tokens?: number;
    max_output_tokens?: number;
  },
  options: { overrides?: Record<string, string> } = {},
): EstimateResult | null {
  const resolved = resolveModel(body.model, { overrides: options.overrides });
  if (!resolved) {
    return null;
  }
  const inputTokens = countMessagesTokens(body.messages);
  const requestedOutput = body.max_tokens ?? body.max_output_tokens;
  const outputTokens =
    typeof requestedOutput === 'number' && requestedOutput > 0
      ? requestedOutput
      : Math.ceil(inputTokens * DEFAULT_OUTPUT_MULTIPLIER);
  const price = pricingFor(resolved.model, resolved.provider);
  const cost =
    (inputTokens / 1_000_000) * price.inputPerM +
    (outputTokens / 1_000_000) * price.outputPerM;
  return {
    model: resolved.model,
    provider: resolved.provider,
    input_tokens: inputTokens,
    estimated_output_tokens: outputTokens,
    estimated_cost_usd: Math.round(cost * 1_000_000) / 1_000_000,
    currency: 'USD',
  };
}

/** A fixed-window per-client rate limiter for `/v1/estimate` (60/min legacy). */
export class EstimateRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<
    string,
    { count: number; start: number }
  >();

  constructor(
    options: { limit?: number; windowMs?: number; now?: () => number } = {},
  ) {
    this.limit = options.limit ?? 60;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Record a request for `clientKey`; returns whether it is allowed. */
  check(clientKey: string): { allowed: boolean; retryAfterMs?: number } {
    const now = this.now();
    const entry = this.windows.get(clientKey);
    if (!entry || now - entry.start >= this.windowMs) {
      this.windows.set(clientKey, { count: 1, start: now });
      return { allowed: true };
    }
    if (entry.count >= this.limit) {
      return {
        allowed: false,
        retryAfterMs: this.windowMs - (now - entry.start),
      };
    }
    entry.count += 1;
    return { allowed: true };
  }

  /** Drop windows that have fully expired (call periodically to bound memory). */
  purge(): void {
    const now = this.now();
    for (const [key, entry] of this.windows) {
      if (now - entry.start >= this.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}
