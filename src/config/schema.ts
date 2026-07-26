/**
 * Configuration schema v1 (epic AIPP-2, subtask 2.3; FR-CONFIG-001/004/007).
 *
 * The single, zod-validated schema that replaces the four legacy config
 * surfaces. Every field has a default so `configSchema.parse({})` yields a
 * complete default configuration. Secrets are never embedded: providers and
 * integrations reference credentials by env var or file (FR-CONFIG-004).
 *
 * Objects use `.passthrough()` so unknown keys are preserved rather than
 * silently dropped (FR-CONFIG-003); the loader surfaces them as warnings.
 */

import { z } from 'zod';

/** Config schema version. */
export const CONFIG_VERSION = 1 as const;

/** Routing modes supported by the gateway. */
export const ROUTING_MODES = [
  'standard',
  'cascade',
  'auto',
  'passthrough',
  'complexity',
] as const;

/** Tokemetry project-identity handling modes. */
export const PROJECT_MODES = ['raw', 'alias', 'hash', 'omit'] as const;

const port = z.number().int().min(1).max(65535);

/** A secret referenced by environment variable or file, never embedded. */
export const credentialRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('env'), name: z.string().min(1) }),
  z.object({ type: z.literal('file'), path: z.string().min(1) }),
]);

export const serverSchema = z
  .object({
    port: port.default(4100),
    host: z.string().min(1).default('127.0.0.1'),
    accessToken: z.string().min(1).nullable().default(null),
  })
  .passthrough();

/** OpenAI Responses surface config (epic AIPP-7; FR-RESP-011/012). */
export const openaiResponsesProtocolSchema = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * Hosted-tool types allowed to pass through to a direct OpenAI upstream that
     * executes them (web_search, file_search, ...). Empty means every hosted
     * tool is rejected with a capability error; the gateway never emulates them.
     */
    allowedHostedTools: z.array(z.string()).default([]),
  })
  .passthrough();

export const protocolsSchema = z
  .object({
    anthropicMessages: z.boolean().default(true),
    openaiChat: z.boolean().default(true),
    openaiResponses: openaiResponsesProtocolSchema.default({}),
  })
  .passthrough();

export const providerSchema = z
  .object({
    enabled: z.boolean().default(true),
    baseUrl: z.string().url().optional(),
    credential: credentialRefSchema.optional(),
  })
  .passthrough();

/**
 * Z.ai Coding Plan gate (epic AIPP-9, subtask 9.5; FR-PA-ZAI-008/009, NG-005).
 * The flag exists so config is explicit, but there is no implementation behind
 * it and startup validation rejects enabling it (see loader.ts).
 */
export const zaiCodingPlanSchema = z
  .object({ enabled: z.boolean().default(false) })
  .passthrough();

/** Z.ai provider config: the base provider entry plus the Coding Plan gate. */
export const zaiProviderSchema = providerSchema.extend({
  codingPlan: zaiCodingPlanSchema.default({}),
});

export const providersSchema = z
  .object({
    anthropic: providerSchema.optional(),
    openai: providerSchema.optional(),
    zai: zaiProviderSchema.optional(),
    google: providerSchema.optional(),
    ollama: providerSchema.optional(),
  })
  // openai-compatible custom providers are validated like any provider entry.
  .catchall(providerSchema);

export const modelsSchema = z
  .object({
    overrides: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

export const routingSchema = z
  .object({
    mode: z.enum(ROUTING_MODES).default('standard'),
    complexity: z
      .object({ enabled: z.boolean().default(false) })
      .passthrough()
      .default({}),
    cascade: z
      .object({ enabled: z.boolean().default(false) })
      .passthrough()
      .default({}),
    crossProviderCascade: z
      .object({
        enabled: z.boolean().default(false),
        triggerStatuses: z.array(z.number().int()).default([429, 529, 503]),
        /** Ordered provider ids to try; primary first, rest are fallbacks. */
        providers: z.array(z.string()).default([]),
        /** Custom [from][to][model] mappings overlaid on the built-ins. */
        modelMapping: z
          .record(
            z.string(),
            z.record(z.string(), z.record(z.string(), z.string())),
          )
          .default({}),
      })
      .passthrough()
      .default({}),
    /** Per-provider cooldown circuit breaker (epic AIPP-10, 10.4). */
    cooldown: z
      .object({
        enabled: z.boolean().default(true),
        allowedFails: z.number().int().min(1).default(3),
        windowSeconds: z.number().int().min(1).default(60),
        cooldownSeconds: z.number().int().min(1).default(120),
      })
      .passthrough()
      .default({}),
    /** Budget-driven auto-downgrade to a cheaper model (epic AIPP-10, 10.2). */
    downgrade: z
      .object({
        enabled: z.boolean().default(false),
        thresholdPercent: z.number().min(0).default(80),
        mapping: z.record(z.string(), z.string()).default({}),
      })
      .passthrough()
      .default({}),
    /** Pre-stream same-model retry with backoff (epic AIPP-10, 10.3). */
    retry: z
      .object({
        maxRetries: z.number().int().min(0).default(2),
        baseDelayMs: z.number().int().min(0).default(250),
        maxDelayMs: z.number().int().min(0).default(4000),
        jitter: z.boolean().default(true),
      })
      .passthrough()
      .default({}),
    policy: z
      .object({ enforce: z.boolean().default(false) })
      .passthrough()
      .default({}),
  })
  .passthrough();

/**
 * Unified budget enforcement (epic AIPP-11, subtask 11.2). One daily/hourly/
 * per-request spend ceiling with a breach action; replaces the two overlapping
 * legacy trackers.
 */
export const budgetSchema = z
  .object({
    enabled: z.boolean().default(false),
    dailyUsd: z.number().nonnegative().default(50),
    hourlyUsd: z.number().nonnegative().default(10),
    perRequestUsd: z.number().nonnegative().default(2),
    onBreach: z
      .enum(['block', 'warn', 'downgrade', 'alert'])
      .default('downgrade'),
    downgradeTo: z.string().default('claude-sonnet-4-6'),
    alertThresholds: z.array(z.number()).default([50, 80, 95]),
  })
  .passthrough();

/** Response cache (epic AIPP-11, subtask 11.4): exact-match, deterministic-gated. */
export const cacheSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxSizeMb: z.number().positive().default(100),
    defaultTtlSeconds: z.number().int().positive().default(3600),
    onlyWhenDeterministic: z.boolean().default(true),
  })
  .passthrough();

/** Alerting (epic AIPP-11, subtask 11.3): threshold/anomaly/breach + opt-in webhook. */
export const alertsSchema = z
  .object({
    enabled: z.boolean().default(false),
    webhookUrl: z.string().url().optional(),
    cooldownMs: z.number().int().min(0).default(300_000),
    maxHistory: z.number().int().positive().default(500),
  })
  .passthrough();

/** Anomaly detection (epic AIPP-11, subtask 11.3): sliding-window heuristics. */
export const anomalySchema = z
  .object({
    enabled: z.boolean().default(false),
    velocityThreshold: z.number().int().positive().default(50),
    tokenExplosionUsd: z.number().nonnegative().default(5),
    repetitionThreshold: z.number().int().positive().default(20),
    windowMs: z.number().int().positive().default(300_000),
  })
  .passthrough();

export const contentLogSchema = z
  .object({
    enabled: z.boolean().default(true),
    retentionDays: z.number().int().positive().default(7),
    maxEntries: z.number().int().positive().default(10000),
  })
  .passthrough();

/** Mesh is local-only in v1: no remote URL is accepted. */
export const meshSchema = z
  .object({ enabled: z.boolean().default(false) })
  .passthrough();

export const tokemetrySchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().optional(),
    credential: credentialRefSchema.optional(),
    machine: z.string().optional(),
    project: z
      .object({
        mode: z.enum(PROJECT_MODES).default('hash'),
        value: z.string().optional(),
      })
      .passthrough()
      .default({}),
    queuePath: z.string().optional(),
    batchMaxEvents: z.number().int().positive().default(100),
    batchMaxBytes: z.number().int().positive().default(1_000_000),
    queueMaxBytes: z.number().int().positive().default(50_000_000),
  })
  .passthrough();

/** A single tool entry within a pack. `inherit` defers to the pack default. */
export const toolEntrySchema = z
  .object({
    name: z.string().min(1),
    policy: z.enum(['allow', 'deny', 'inherit']).default('inherit'),
    requiresConfirmation: z.boolean().optional(),
  })
  .passthrough();

/** A named tool pack: an allow/deny set with a default for unlisted tools. */
export const toolPackSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(''),
    tools: z.array(toolEntrySchema).default([]),
    defaultPolicy: z.enum(['allow', 'deny']).default('deny'),
    version: z.string().default('1.0.0'),
  })
  .passthrough();

/** Per-agent pack additions/removals and explicit tool overrides. */
export const agentAuthConfigSchema = z
  .object({
    allowPacks: z.array(z.string()).default([]),
    denyPacks: z.array(z.string()).default([]),
    toolOverrides: z.record(z.string(), z.enum(['allow', 'deny'])).default({}),
  })
  .passthrough();

/** Tool authorization (deny-by-default when enabled; FR-TOOLS-008). */
export const toolsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Custom packs; overlay (and may override) the built-in packs by name. */
    packs: z.array(toolPackSchema).default([]),
    /** Agent auth configs keyed by agent id. */
    agents: z.record(z.string(), agentAuthConfigSchema).default({}),
    /** Global explicit deny list; always wins over pack/agent policy. */
    denyList: z.array(z.string()).default([]),
  })
  .passthrough();

export const integrationsSchema = z
  .object({ tokemetry: tokemetrySchema.default({}) })
  .passthrough();

/** The complete config schema v1. */
export const configSchema = z
  .object({
    version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
    server: serverSchema.default({}),
    protocols: protocolsSchema.default({}),
    providers: providersSchema.default({}),
    models: modelsSchema.default({}),
    routing: routingSchema.default({}),
    budget: budgetSchema.default({}),
    cache: cacheSchema.default({}),
    alerts: alertsSchema.default({}),
    anomaly: anomalySchema.default({}),
    contentLog: contentLogSchema.default({}),
    mesh: meshSchema.default({}),
    tools: toolsSchema.default({}),
    integrations: integrationsSchema.default({}),
  })
  .passthrough();

/** The validated, defaulted config type. */
export type Config = z.infer<typeof configSchema>;
export type CredentialRef = z.infer<typeof credentialRefSchema>;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** Names of the known top-level config sections. */
export const KNOWN_TOP_LEVEL_KEYS: readonly string[] = Object.keys(
  configSchema.shape,
);

/** Build a complete configuration from defaults. */
export function defaultConfig(): Config {
  return configSchema.parse({});
}
