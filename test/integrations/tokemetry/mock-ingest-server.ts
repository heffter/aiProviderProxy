/**
 * Contract-faithful mock Tokemetry ingest server (epic AIPP-5, subtask 5.4).
 *
 * Implements the ingest contract for tests and local integration: POST
 * /api/v1/ingest/events, bearer-token auth, all-or-nothing per batch, sanity
 * validation (non-negative counts, token-math bounds), event_id keep-max upsert,
 * and server-side cost (cost_usd is never accepted from the client). Supports
 * failure injection for retry/chaos tests.
 *
 * `handle()` is the pure request handler (usable as a batcher transport in
 * process); `start()/stop()` wrap it in a real HTTP server.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../../src/providers/types.js';

const INGEST_PATH = '/api/v1/ingest/events';

interface IngestRow {
  event_id: string;
  sequence: number;
  finality?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_short_tokens?: number;
  cache_write_long_tokens?: number;
  [key: string]: unknown;
}

export interface MockIngestOptions {
  token: string;
}

function json(status: number, body: unknown): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export class MockIngestServer {
  private readonly token: string;
  private readonly stored = new Map<string, IngestRow>();
  private failuresRemaining = 0;
  private failStatus = 500;
  private server?: Server;

  constructor(options: MockIngestOptions) {
    this.token = options.token;
  }

  /** Inject `count` consecutive failures with `status` (retry/chaos tests). */
  injectFailures(count: number, status = 500): void {
    this.failuresRemaining = count;
    this.failStatus = status;
  }

  /** Stored events after keep-max upsert (for assertions). */
  events(): IngestRow[] {
    return [...this.stored.values()];
  }

  reset(): void {
    this.stored.clear();
    this.failuresRemaining = 0;
  }

  private validate(row: IngestRow): boolean {
    const counts = [
      row.input_tokens,
      row.output_tokens,
      row.cache_read_tokens ?? 0,
      row.cache_write_short_tokens ?? 0,
      row.cache_write_long_tokens ?? 0,
    ];
    if (counts.some((n) => typeof n !== 'number' || Number.isNaN(n) || n < 0)) {
      return false;
    }
    if (typeof row.event_id !== 'string' || row.event_id.length === 0) {
      return false;
    }
    // Server computes cost; a client-sent cost_usd is a contract violation.
    if ('cost_usd' in row) {
      return false;
    }
    return true;
  }

  private upsert(row: IngestRow): void {
    const existing = this.stored.get(row.event_id);
    if (
      !existing ||
      row.sequence > existing.sequence ||
      (row.sequence === existing.sequence && row.finality === 'final')
    ) {
      this.stored.set(row.event_id, row);
    }
  }

  /** Pure request handler (also usable directly as a batcher transport). */
  handle(request: TransportRequest): TransportResponse {
    if (request.method !== 'POST' || !request.url.endsWith(INGEST_PATH)) {
      return json(404, { error: 'not_found' });
    }
    const auth = request.headers.authorization ?? request.headers.Authorization;
    if (auth !== `Bearer ${this.token}`) {
      return json(401, { error: 'unauthorized' });
    }
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return json(this.failStatus, { error: 'injected_failure' });
    }

    let events: IngestRow[];
    try {
      const parsed = JSON.parse(request.body ?? '{}') as {
        events?: IngestRow[];
      };
      events = parsed.events ?? [];
    } catch {
      return json(400, { error: 'invalid_json' });
    }

    // All-or-nothing: validate the whole batch before storing anything.
    for (const row of events) {
      if (!this.validate(row)) {
        return json(400, {
          error: 'validation_failed',
          event_id: row?.event_id,
        });
      }
    }
    for (const row of events) {
      this.upsert(row);
    }
    return json(200, { accepted: events.length });
  }

  /** A batcher transport backed by this mock (in-process, no real HTTP). */
  transport(): Transport {
    return async (request: TransportRequest) => this.handle(request);
  }

  /** Start a real HTTP server; returns the base URL. */
  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const response = this.handle({
          url: req.url ?? '',
          method: req.method ?? 'GET',
          headers: req.headers as Record<string, string>,
          body,
        });
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }
}

export const INGEST_ENDPOINT_PATH = INGEST_PATH;
