/**
 * History sink (epic AIPP-3, subtask 3.4).
 *
 * Appends one JSONL entry per logical request to history.jsonl. Request/response
 * CONTENT is optional and gated by config (contentLogEnabled): it is supplied
 * out-of-band via a getContent callback and lives ONLY in this local sink -- it
 * is never part of a canonical usage event. With content logging off, entries
 * carry metadata and token counts only.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageEventSink } from '../../lifecycle/event-sinks.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';
import { dataFile, DATA_FILES } from './paths.js';

/** Local-only request/response content, never present in canonical events. */
export interface HistoryContent {
  request?: unknown;
  response?: unknown;
}

/** A single history.jsonl entry. */
export interface HistoryEntry {
  schemaVersion: 2;
  id: string;
  timestamp: string;
  provider: string;
  requestedModel: string;
  routedModel: string;
  nativeModel: string;
  outcome: string;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  sessionId?: string;
  agentId?: string;
  costEstimateUsd?: number;
  content?: HistoryContent;
}

export interface HistorySinkOptions {
  dir?: string;
  contentLogEnabled?: boolean;
  /** Supplies local-only content for an event when content logging is enabled. */
  getContent?: (event: CanonicalUsageEvent) => HistoryContent | undefined;
}

export class HistorySink implements UsageEventSink {
  readonly name = 'history';
  private readonly path: string;
  private readonly contentLogEnabled: boolean;
  private readonly getContent?: (
    event: CanonicalUsageEvent,
  ) => HistoryContent | undefined;

  constructor(options: HistorySinkOptions = {}) {
    this.path = dataFile(DATA_FILES.history, options.dir);
    this.contentLogEnabled = options.contentLogEnabled ?? false;
    this.getContent = options.getContent;
  }

  onLogicalRequestFinal(event: CanonicalUsageEvent): void {
    const entry: HistoryEntry = {
      schemaVersion: 2,
      id: event.logicalRequestId,
      timestamp: event.timestampCompleted,
      provider: event.provider,
      requestedModel: event.requestedModel,
      routedModel: event.routedModel,
      nativeModel: event.nativeModel,
      outcome: event.outcome,
      success: event.success,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      latencyMs: event.latencyMs,
      sessionId: event.sessionId,
      agentId: event.agentId,
      costEstimateUsd: event.costEstimateUsd,
    };

    if (this.contentLogEnabled && this.getContent) {
      const content = this.getContent(event);
      if (content) {
        entry.content = content;
      }
    }

    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
