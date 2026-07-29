/**
 * In-memory request/response content buffer (epic AIPP-11, Task 16).
 *
 * Bridges the gateway (which sees the winning attempt's request and response
 * bodies) to the {@link HistorySink} (which writes them to history.jsonl only
 * when content logging is on). The gateway calls {@link ContentBuffer.record}
 * on the winning attempt; HistorySink.getContent drains the entry via
 * {@link ContentBuffer.take} (read-and-clear) keyed by logicalRequestId.
 *
 * Content lives ONLY here and in the local history log -- it is deliberately
 * kept out of the canonical usage event (usage-event.ts never spreads request/
 * response objects) so it can never reach the Tokemetry outbox or export.
 *
 * Every stored value is redacted (credential shapes and sensitive keys removed)
 * and bounded by the same size/JSON-depth limits the gateway enforces on
 * inbound requests; an oversized or too-deep value is replaced by an omission
 * marker rather than stored verbatim. The map is capped by entry count and
 * evicts oldest-first so a drain that never arrives cannot grow it without
 * bound.
 */

import { redactValue } from '../config/redact.js';
import type { HistoryContent } from '../ops/trackers/history-sink.js';
import { checkRequestLimits, type LimitPolicy } from './limits.js';

/** Default cap on buffered (undrained) entries, matching contentLog.maxEntries. */
export const DEFAULT_MAX_ENTRIES = 10000;

export interface ContentBufferOptions {
  /** Maximum undrained entries before oldest-first eviction. */
  maxEntries?: number;
  /** Size / JSON-depth bounds for a stored value; gateway defaults when omitted. */
  limits?: LimitPolicy;
}

/** A value that exceeded the size or depth bound, stored in place of content. */
interface OmittedContent {
  omitted: string;
}

export class ContentBuffer {
  private readonly store = new Map<string, HistoryContent>();
  private readonly maxEntries: number;
  private readonly limits: LimitPolicy;

  constructor(options: ContentBufferOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.limits = options.limits ?? {};
  }

  /**
   * Record the winning attempt's request and response for a logical request.
   * Both are redacted and bounded before storage. A repeat id overwrites the
   * previous entry; at capacity the oldest entry is evicted first.
   */
  record(logicalRequestId: string, request: unknown, response: unknown): void {
    if (
      this.store.size >= this.maxEntries &&
      !this.store.has(logicalRequestId)
    ) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(logicalRequestId, {
      request: this.bound(redactValue(request)),
      response: this.bound(redactValue(response)),
    });
  }

  /**
   * Read and remove the content for a logical request. Returns undefined when
   * nothing was recorded (e.g. a failed request or a cache hit), so the sink
   * writes a metadata-only entry.
   */
  take(logicalRequestId: string): HistoryContent | undefined {
    const content = this.store.get(logicalRequestId);
    if (content) {
      this.store.delete(logicalRequestId);
    }
    return content;
  }

  /** Number of entries awaiting drain (diagnostics/tests). */
  get size(): number {
    return this.store.size;
  }

  /**
   * Bound a redacted value by the gateway's size and JSON-depth limits. A value
   * that breaches either limit -- or cannot be serialized -- is replaced by an
   * omission marker so the history log stays cheap to write and read.
   */
  private bound(value: unknown): unknown {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      const omitted: OmittedContent = { omitted: 'content not serializable' };
      return omitted;
    }
    if (json === undefined) {
      // A top-level undefined (or a function/symbol) has no JSON form; keep it
      // as-is so the caller's shape is preserved without a stored marker.
      return value;
    }
    const check = checkRequestLimits(json, this.limits);
    if (!check.ok) {
      const omitted: OmittedContent = {
        omitted: check.reason ?? 'content too large',
      };
      return omitted;
    }
    return value;
  }
}
