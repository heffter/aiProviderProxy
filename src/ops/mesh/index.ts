/**
 * Local-only mesh / osmosis learning store (epic AIPP-11, subtask 11.5).
 *
 * No network egress: the legacy remote sync and cloud router are deleted.
 */

export {
  MeshStore,
  type KnowledgeAtom,
  type EpisodicEvent,
  type MeshStoreOptions,
} from './store.js';

export { MeshSink } from './sink.js';
