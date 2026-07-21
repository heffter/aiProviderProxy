/**
 * Model registry (epic AIPP-4, subtask 4.2).
 *
 * Holds model records (provider, native id, aliases, lifecycle, context/output
 * limits, capability states) and offers capability filtering for the routing
 * layer. Alias/prefix resolution lives in aliases.ts; this registry keys records
 * by their native id.
 */

import {
  supportsCapability,
  UNKNOWN_CAPABILITIES,
  type CapabilityName,
  type ModelCapabilities,
} from './capabilities.js';

/** Model lifecycle status. */
export type LifecycleStatus = 'ga' | 'preview' | 'deprecated' | 'retired';

/** A registered model. */
export interface ModelRecord {
  /** Native (upstream) model id -- the registry key. */
  nativeId: string;
  provider: string;
  aliases: string[];
  lifecycle: LifecycleStatus;
  contextLimit?: number;
  outputLimit?: number;
  capabilities: ModelCapabilities;
}

/** Build a model record with sensible defaults. */
export function modelRecord(
  init: Partial<ModelRecord> & { nativeId: string; provider: string },
): ModelRecord {
  return {
    aliases: [],
    lifecycle: 'ga',
    capabilities: { ...UNKNOWN_CAPABILITIES },
    ...init,
  };
}

export class ModelRegistry {
  private readonly byId = new Map<string, ModelRecord>();

  register(record: ModelRecord): void {
    this.byId.set(record.nativeId, record);
  }

  registerAll(records: ModelRecord[]): void {
    for (const record of records) {
      this.register(record);
    }
  }

  get(nativeId: string): ModelRecord | undefined {
    return this.byId.get(nativeId);
  }

  list(): ModelRecord[] {
    return [...this.byId.values()];
  }

  /** Models (optionally within a provider) that support `capability`. */
  filterByCapability(
    capability: CapabilityName,
    options: { provider?: string; conditionalCounts?: boolean } = {},
  ): ModelRecord[] {
    return this.list().filter((record) => {
      if (options.provider && record.provider !== options.provider) {
        return false;
      }
      return supportsCapability(record.capabilities, capability, {
        conditionalCounts: options.conditionalCounts,
      });
    });
  }
}
