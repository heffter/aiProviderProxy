/**
 * Built-in model records (epic AIPP-9, subtask 9.2).
 *
 * Registry entries with verified capability flags and context/output limits.
 * The routing layer (AIPP-10) selects models by capability from these records;
 * no handler code references model names directly (NFR-MAIN-003). Currently
 * seeds the Z.ai GLM family; other providers' records are added as their epics
 * land.
 *
 * GLM capabilities and limits verified against the Z.ai GLM model card as of
 * 2026-07: streaming, tools, and reasoning supported; prompt caching supported;
 * ~200K context.
 */

import { ModelRegistry, modelRecord, type ModelRecord } from './registry.js';

/** Z.ai GLM model records. */
export const GLM_MODELS: ModelRecord[] = [
  modelRecord({
    nativeId: 'glm-5.2',
    provider: 'zai',
    aliases: ['glm', 'zai/glm-5.2'],
    lifecycle: 'ga',
    contextLimit: 200_000,
    outputLimit: 32_768,
    capabilities: {
      streaming: 'supported',
      tools: 'supported',
      vision: 'unsupported',
      promptCaching: 'supported',
      reasoning: 'supported',
    },
  }),
  modelRecord({
    nativeId: 'glm-5-turbo',
    provider: 'zai',
    aliases: ['zai/glm-5-turbo'],
    lifecycle: 'ga',
    contextLimit: 128_000,
    outputLimit: 16_384,
    capabilities: {
      streaming: 'supported',
      tools: 'supported',
      vision: 'unsupported',
      promptCaching: 'supported',
      // The turbo tier trades reasoning for latency.
      reasoning: 'unsupported',
    },
  }),
  modelRecord({
    nativeId: 'glm-4.7',
    provider: 'zai',
    aliases: ['zai/glm-4.7'],
    lifecycle: 'ga',
    contextLimit: 128_000,
    outputLimit: 16_384,
    capabilities: {
      streaming: 'supported',
      tools: 'supported',
      vision: 'unsupported',
      promptCaching: 'supported',
      reasoning: 'supported',
    },
  }),
];

/** All built-in model records. */
export const BUILTIN_MODELS: ModelRecord[] = [...GLM_MODELS];

/** Build a model registry seeded with every built-in record. */
export function buildModelRegistry(
  records: ModelRecord[] = BUILTIN_MODELS,
): ModelRegistry {
  const registry = new ModelRegistry();
  registry.registerAll(records);
  return registry;
}
