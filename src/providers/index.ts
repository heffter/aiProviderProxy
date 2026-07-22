/**
 * Upstream provider adapters and dispatch (epic AIPP-4).
 */

export * from './types.js';
export * from './registry.js';
export * from './errors.js';
export * from './openai-compatible.js';
export * from './anthropic/index.js';
export * from './openai/index.js';

/** Identifies this module within the target skeleton. */
export const MODULE_NAME = 'providers';
