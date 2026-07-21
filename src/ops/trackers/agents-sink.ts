/**
 * Agents sink (epic AIPP-3, subtask 3.4).
 *
 * Maintains a fingerprint registry in agents.json keyed by agentId. Each
 * logical-request-final event upserts the agent's first/last-seen timestamps,
 * request count, and the set of models/providers seen. No prompt content is
 * stored (the legacy 80-char system-prompt preview is intentionally dropped).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageEventSink } from '../../lifecycle/event-sinks.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';
import { dataFile, DATA_FILES } from './paths.js';

/** A registry entry for one agent fingerprint. */
export interface AgentRecord {
  agentId: string;
  firstSeen: string;
  lastSeen: string;
  requestCount: number;
  models: string[];
  providers: string[];
}

export interface AgentsSinkOptions {
  dir?: string;
}

function addUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) {
    list.push(value);
  }
}

export class AgentsSink implements UsageEventSink {
  readonly name = 'agents';
  private readonly path: string;

  constructor(options: AgentsSinkOptions = {}) {
    this.path = dataFile(DATA_FILES.agents, options.dir);
  }

  /** Load the current registry (empty on missing/corrupt file). */
  read(): Record<string, AgentRecord> {
    if (!existsSync(this.path)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<
        string,
        AgentRecord
      >;
    } catch {
      return {};
    }
  }

  onLogicalRequestFinal(event: CanonicalUsageEvent): void {
    if (!event.agentId) {
      return;
    }
    const registry = this.read();
    const existing = registry[event.agentId];
    const record: AgentRecord = existing ?? {
      agentId: event.agentId,
      firstSeen: event.timestampStarted,
      lastSeen: event.timestampCompleted,
      requestCount: 0,
      models: [],
      providers: [],
    };
    record.lastSeen = event.timestampCompleted;
    record.requestCount += 1;
    addUnique(record.models, event.requestedModel);
    addUnique(record.providers, event.provider);
    registry[event.agentId] = record;

    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  }
}
