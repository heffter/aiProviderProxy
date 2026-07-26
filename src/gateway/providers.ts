/**
 * Provider registry assembly for the gateway (epic AIPP-6, subtask 6.2).
 *
 * Registers the concrete adapters -- Anthropic, OpenAI, and the eight
 * OpenAI-compatible providers -- under their canonical ids so the gateway can
 * dispatch by resolved provider. Unknown providers remain a hard error in the
 * registry (no misroute).
 */

import { createAnthropicAdapter } from '../providers/anthropic/index.js';
import { createOpenAIAdapter } from '../providers/openai/index.js';
import { createGoogleAdapter } from '../providers/google/index.js';
import { createOllamaAdapter } from '../providers/ollama/index.js';
import { registerOpenAICompatibleProviders } from '../providers/openai-compatible.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { TokenPool } from '../providers/anthropic/index.js';

export interface BuildRegistryDeps {
  env?: NodeJS.ProcessEnv;
  anthropicTokenPool?: TokenPool;
}

/** Build a registry with every built-in provider adapter registered. */
export function buildProviderRegistry(
  deps: BuildRegistryDeps = {},
): ProviderRegistry {
  const env = deps.env ?? process.env;
  const registry = new ProviderRegistry();
  registry.register(
    createAnthropicAdapter({ env, tokenPool: deps.anthropicTokenPool }),
  );
  registry.register(createOpenAIAdapter({ env }));
  registry.register(createGoogleAdapter({ env }));
  registry.register(createOllamaAdapter());
  registerOpenAICompatibleProviders(registry, { env });
  return registry;
}
