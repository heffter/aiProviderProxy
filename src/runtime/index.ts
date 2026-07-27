/**
 * Runtime composition (Task 15).
 *
 * The composition root that assembles every subsystem from config and owns its
 * lifecycle, turning a bare routing proxy into the fully wired gateway that
 * `aipp start` runs.
 */

export {
  createGatewayRuntime,
  resolveCredential,
  type GatewayRuntime,
  type RuntimeOptions,
} from './composition.js';

/** Identifies this module within the target skeleton. */
export const MODULE_NAME = 'runtime';
