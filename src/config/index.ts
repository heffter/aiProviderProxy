/**
 * Configuration: schema, single loader, and redaction.
 *
 * Public entry point for the AIPP-2 configuration subsystem (PRD section 10.1).
 */

export * from './schema.js';
export * from './loader.js';
export * from './redact.js';
export * from './migrate-relayplane.js';

/** Identifies this module within the target skeleton. */
export const MODULE_NAME = 'config';
