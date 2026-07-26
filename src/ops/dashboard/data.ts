/**
 * Dashboard data builders (epic AIPP-11, subtask 11.1; FR-IDENT-006).
 *
 * Pure functions that assemble the local dashboard's API payloads from the
 * history log, the budget ledger, and the Tokemetry exporter health. Request and
 * response CONTENT is included only when content logging is enabled; with it off,
 * runs carry metadata and token counts only (NFR-PRIV-003).
 */

import { existsSync, readFileSync } from 'node:fs';
import type { HistoryEntry } from '../trackers/history-sink.js';

/** Read up to `limit` most-recent history entries (newest first). */
export function readHistory(path: string, limit = 100): HistoryEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed) as HistoryEntry);
    } catch {
      // skip a corrupt line
    }
  }
  return entries.reverse().slice(0, limit);
}

/**
 * Strip request/response content from a run unless content logging is on. The
 * returned object is a copy; the on-disk entry is untouched.
 */
export function gateContent(
  entry: HistoryEntry,
  contentLogEnabled: boolean,
): HistoryEntry {
  if (contentLogEnabled) {
    return entry;
  }
  const { content: _content, ...rest } = entry;
  void _content;
  return rest as HistoryEntry;
}

/** A run in a list view: gated content applied. */
export function listRuns(
  path: string,
  contentLogEnabled: boolean,
  limit = 100,
): HistoryEntry[] {
  return readHistory(path, limit).map((e) => gateContent(e, contentLogEnabled));
}

/** A single run by id, with gated content, or undefined. */
export function getRun(
  path: string,
  id: string,
  contentLogEnabled: boolean,
): HistoryEntry | undefined {
  const entry = readHistory(path, 100000).find((e) => e.id === id);
  return entry ? gateContent(entry, contentLogEnabled) : undefined;
}

/** Aggregate dashboard summary. */
export interface DashboardSummary {
  totalRequests: number;
  successRate: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Record<string, { requests: number; costUsd: number }>;
  byAgent: Record<string, { requests: number; costUsd: number }>;
}

/** Build the cost/usage/provider/agent summary from history entries. */
export function summarize(path: string): DashboardSummary {
  const entries = readHistory(path, 100000);
  const summary: DashboardSummary = {
    totalRequests: entries.length,
    successRate: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byProvider: {},
    byAgent: {},
  };
  let successes = 0;
  for (const e of entries) {
    if (e.success) {
      successes += 1;
    }
    const cost = e.costEstimateUsd ?? 0;
    summary.totalCostUsd += cost;
    summary.totalInputTokens += e.inputTokens;
    summary.totalOutputTokens += e.outputTokens;

    const p = (summary.byProvider[e.provider] ??= { requests: 0, costUsd: 0 });
    p.requests += 1;
    p.costUsd += cost;

    if (e.agentId) {
      const a = (summary.byAgent[e.agentId] ??= { requests: 0, costUsd: 0 });
      a.requests += 1;
      a.costUsd += cost;
    }
  }
  summary.successRate = entries.length > 0 ? successes / entries.length : 0;
  return summary;
}
