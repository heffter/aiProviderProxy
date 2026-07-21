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

export const protocolsSchema = z
  .object({
    anthropicMessages: z.boolean().default(true),
    openaiChat: z.boolean().default(true),
  })
  .passthrough();

export const providerSchema = z
  .object({
    enabled: z.boolean().default(true),
    baseUrl: z.string().url().optional(),
    credential: credentialRefSchema.optional(),
  })
  .passthrough();

export const providersSchema = z
  .object({
    anthropic: providerSchema.optional(),
    openai: providerSchema.optional(),
    zai: providerSchema.optional(),
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
      })
      .passthrough()
      .default({}),
    policy: z
      .object({ enforce: z.boolean().default(false) })
      .passthrough()
      .default({}),
  })
  .passthrough();

export const budgetSchema = z
  .object({
    enabled: z.boolean().default(false),
    dailyUsd: z.number().nonnegative().optional(),
  })
  .passthrough();

export const cacheSchema = z
  .object({ enabled: z.boolean().default(true) })
  .passthrough();

export const alertsSchema = z
  .object({ enabled: z.boolean().default(false) })
  .passthrough();

export const anomalySchema = z
  .object({ enabled: z.boolean().default(false) })
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
