/**
 * Model capability states and filtering (epic AIPP-4, subtask 4.2).
 *
 * Capabilities are tri-state-plus: a routing layer must distinguish "known
 * supported" from "unknown" from "conditionally supported" (e.g. vision only for
 * certain model variants) rather than assuming a boolean.
 */

export const CAPABILITY_STATES = [
  'unknown',
  'supported',
  'unsupported',
  'conditional',
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export type CapabilityName =
  'streaming' | 'tools' | 'vision' | 'promptCaching' | 'reasoning';

export type ModelCapabilities = Record<CapabilityName, CapabilityState>;

/** All-unknown capabilities (safe default for an unregistered model). */
export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  streaming: 'unknown',
  tools: 'unknown',
  vision: 'unknown',
  promptCaching: 'unknown',
  reasoning: 'unknown',
};

/**
 * Whether a model supports a capability. `conditional` counts as supported only
 * when `conditionalCounts` is set (the routing layer decides per use case).
 */
export function supportsCapability(
  capabilities: ModelCapabilities,
  name: CapabilityName,
  options: { conditionalCounts?: boolean } = {},
): boolean {
  const state = capabilities[name];
  if (state === 'supported') {
    return true;
  }
  return options.conditionalCounts === true && state === 'conditional';
}
