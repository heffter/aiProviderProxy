/**
 * Content-log retention, permissions, and disclosure (epic AIPP-11, subtask 11.6).
 */

export {
  pruneHistory,
  restrictOwnerOnly,
  type RetentionPolicy,
  type PruneResult,
} from './retention.js';

export { contentLogDisclosure, type DisclosureInput } from './disclosure.js';
