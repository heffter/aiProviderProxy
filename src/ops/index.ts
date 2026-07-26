/**
 * Operational endpoints, runtime controls, and local sink adapters (epic AIPP-3).
 */

export * from './trackers/index.js';
export * from './content-log/index.js';
export * from './budget/index.js';
export * from './anomaly/index.js';
export * from './alerts/index.js';
export * from './cache/index.js';

/** Identifies this module within the target skeleton. */
export const MODULE_NAME = 'ops';
