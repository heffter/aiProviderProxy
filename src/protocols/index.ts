/**
 * Protocol adapters (Anthropic Messages, OpenAI Chat Completions) (epic AIPP-6+).
 */

export * from './anthropic/index.js';
export * from './openai-responses/index.js';
export * from './openai-chat/index.js';

/** Identifies this module within the target skeleton. */
export const MODULE_NAME = 'protocols';
