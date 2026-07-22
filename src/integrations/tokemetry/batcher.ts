/**
 * Tokemetry exporter batcher (epic AIPP-5, subtask 5.3; FR-TOK, NFR-REL).
 *
 * Drains the durable outbox in batches and POSTs them to the ingest API with:
 * - exponential backoff on retryable failures (429/5xx/timeout/connection),
 * - dead-lettering after maxAttempts,
 * - poison splitting: when the server rejects a whole batch as a validation
 *   error (all-or-nothing), the batch is split so the offending event is
 *   isolated to the DLQ and the healthy events still export.
 *
 * The transport is injectable so the batcher is tested against the mock ingest
 * server with no real network.
 */

import {
  classifyGenericError,
  RETRYABLE_CATEGORIES,
} from '../../providers/errors.js';
import type { Transport } from '../../providers/types.js';
import { mapToIngest, type MapperConfig } from './mapper.js';
import type { OutboxRecord, TokemetryOutbox } from './outbox.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';

export interface BatcherConfig {
  endpoint: string;
  token: string;
  batchSize?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  mapperConfig?: MapperConfig;
}

export interface BatcherDeps {
  outbox: TokemetryOutbox;
  transport: Transport;
  now?: () => number;
}

/** Outcome of one flush cycle. */
export interface FlushResult {
  claimed: number;
  exported: number;
  retried: number;
  dead: number;
}

const DEFAULTS = {
  batchSize: 100,
  maxAttempts: 5,
  baseBackoffMs: 1000,
  maxBackoffMs: 5 * 60 * 1000,
};

export class TokemetryBatcher {
  private readonly outbox: TokemetryOutbox;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly cfg: Required<Omit<BatcherConfig, 'mapperConfig'>> & {
    mapperConfig?: MapperConfig;
  };

  constructor(config: BatcherConfig, deps: BatcherDeps) {
    this.outbox = deps.outbox;
    this.transport = deps.transport;
    this.now = deps.now ?? Date.now;
    this.cfg = {
      endpoint: config.endpoint,
      token: config.token,
      batchSize: config.batchSize ?? DEFAULTS.batchSize,
      maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
      baseBackoffMs: config.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: config.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      mapperConfig: config.mapperConfig,
    };
  }

  private backoffMs(attempts: number): number {
    return Math.min(
      this.cfg.baseBackoffMs * 2 ** attempts,
      this.cfg.maxBackoffMs,
    );
  }

  /** Drain one batch from the outbox. */
  async flushOnce(): Promise<FlushResult> {
    const now = this.now();
    const records = this.outbox.claimBatch(this.cfg.batchSize, now);
    const result: FlushResult = {
      claimed: records.length,
      exported: 0,
      retried: 0,
      dead: 0,
    };
    if (records.length === 0) {
      return result;
    }
    await this.handle(records, now, result);
    return result;
  }

  private async post(
    records: OutboxRecord[],
  ): Promise<{ status: number; cause?: unknown }> {
    const events = records.map((r) =>
      mapToIngest(
        JSON.parse(r.payload) as CanonicalUsageEvent,
        this.cfg.mapperConfig,
      ),
    );
    try {
      const res = await this.transport({
        url: this.cfg.endpoint,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.token}`,
        },
        body: JSON.stringify({ events }),
      });
      return { status: res.status };
    } catch (cause) {
      return { status: 0, cause };
    }
  }

  private retireByAttempts(
    records: OutboxRecord[],
    now: number,
    error: string,
    result: FlushResult,
  ): void {
    const toRetry: number[] = [];
    const toDead: number[] = [];
    for (const record of records) {
      if (record.attempts + 1 >= this.cfg.maxAttempts) {
        toDead.push(record.id);
      } else {
        this.outbox.markFailed(
          [record.id],
          now + this.backoffMs(record.attempts),
          error,
        );
        toRetry.push(record.id);
      }
    }
    if (toDead.length > 0) {
      this.outbox.markDead(toDead, `max attempts exceeded: ${error}`);
    }
    result.retried += toRetry.length;
    result.dead += toDead.length;
  }

  private async handle(
    records: OutboxRecord[],
    now: number,
    result: FlushResult,
  ): Promise<void> {
    const { status, cause } = await this.post(records);

    if (status >= 200 && status < 300) {
      this.outbox.markExported(records.map((r) => r.id));
      result.exported += records.length;
      return;
    }

    const category = classifyGenericError({
      status: status || undefined,
      cause,
    });
    const error = `ingest ${status}: ${category}`;

    if (category === 'provider_validation_error') {
      // Poison: the whole batch was rejected. Isolate the offender.
      if (records.length === 1) {
        this.outbox.markDead([records[0].id], `poison: ${error}`);
        result.dead += 1;
        return;
      }
      for (const record of records) {
        await this.handle([record], now, result);
      }
      return;
    }

    if (
      RETRYABLE_CATEGORIES.has(category) ||
      category === 'provider_auth_error'
    ) {
      this.retireByAttempts(records, now, error, result);
      return;
    }

    // Unknown/internal: treat as retryable-with-attempts.
    this.retireByAttempts(records, now, error, result);
  }
}
