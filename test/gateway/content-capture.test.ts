/**
 * End-to-end content-capture tests (Task 16).
 *
 * Drives a real request through the gateway with a HistorySink backed by the
 * live ContentBuffer and asserts the disclosure contract:
 *  - content logging ON  -> history.jsonl carries request + response content;
 *  - content logging OFF -> history entries are metadata-only;
 *  - in BOTH cases the request/response text never reaches the canonical usage
 *    event or the Tokemetry outbox.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createGateway,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { ContentBuffer } from '../../src/gateway/content-buffer.js';
import { HistorySink } from '../../src/ops/trackers/history-sink.js';
import { defaultConfig } from '../../src/config/index.js';
import { EventSinkRegistry } from '../../src/lifecycle/index.js';
import { TokemetryOutbox } from '../../src/integrations/tokemetry/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { Transport } from '../../src/providers/types.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-envkey',
} as NodeJS.ProcessEnv;

const PROMPT_MARKER = 'PROMPT_MARKER_7f3a91';
const REPLY_MARKER = 'REPLY_MARKER_9b2c40';

/** Anthropic fast-path response carrying the reply marker. */
const anthropicResponse: Transport = async () => ({
  status: 200,
  headers: { 'request-id': 'req_ant' },
  body: JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: REPLY_MARKER }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 4 },
  }),
});

function post(): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4',
      max_tokens: 256,
      messages: [{ role: 'user', content: PROMPT_MARKER }],
    }),
  };
}

function harness(contentLogEnabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'aipp-content-'));
  const config = defaultConfig();
  config.contentLog.enabled = contentLogEnabled;
  const events: CanonicalUsageEvent[] = [];
  const contentBuffer = new ContentBuffer();
  const sinks = new EventSinkRegistry();
  sinks.register({
    name: 'capture',
    onLogicalRequestFinal: (e) => {
      events.push(e);
    },
  });
  sinks.register(
    new HistorySink({
      dir,
      contentLogEnabled,
      getContent: (event) => contentBuffer.take(event.logicalRequestId),
    }),
  );
  const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
  const gateway = createGateway({
    config,
    registry: buildProviderRegistry({ env }),
    transport: anthropicResponse,
    sinks,
    outbox,
    contentBuffer,
    dataDir: dir,
  });
  return { gateway, events, sinks, outbox, contentBuffer, dir };
}

function readHistory(dir: string): Record<string, unknown> {
  const raw = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim();
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('live content capture', () => {
  it('records request + response content when content logging is ON', async () => {
    const { gateway, events, sinks, outbox, contentBuffer, dir } =
      harness(true);
    try {
      const res = await gateway.handle(post());
      await sinks.drain();
      expect(res.status).toBe(200);

      // History carries the content under the dedicated field.
      const entry = readHistory(dir);
      const content = entry.content as {
        request?: unknown;
        response?: unknown;
      };
      expect(content).toBeDefined();
      expect(JSON.stringify(content.request)).toContain(PROMPT_MARKER);
      expect(JSON.stringify(content.response)).toContain(REPLY_MARKER);

      // The buffer was drained read-and-clear by the sink.
      expect(contentBuffer.size).toBe(0);

      // Content NEVER reaches the canonical event or the export outbox.
      expect(JSON.stringify(events)).not.toContain(PROMPT_MARKER);
      expect(JSON.stringify(events)).not.toContain(REPLY_MARKER);
      const queued = outbox.claimBatch(100).map((r) => r.payload);
      expect(queued.length).toBeGreaterThan(0);
      for (const payload of queued) {
        expect(payload).not.toContain(PROMPT_MARKER);
        expect(payload).not.toContain(REPLY_MARKER);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes metadata-only history when content logging is OFF', async () => {
    const { gateway, events, sinks, outbox, contentBuffer, dir } =
      harness(false);
    try {
      const res = await gateway.handle(post());
      await sinks.drain();
      expect(res.status).toBe(200);

      // No content field, and the markers appear nowhere in the log.
      const entry = readHistory(dir);
      expect(entry).not.toHaveProperty('content');
      const rawHistory = readFileSync(join(dir, 'history.jsonl'), 'utf8');
      expect(rawHistory).not.toContain(PROMPT_MARKER);
      expect(rawHistory).not.toContain(REPLY_MARKER);

      // The gateway never populated the buffer while logging was off.
      expect(contentBuffer.size).toBe(0);

      // And still nothing leaks to events or the outbox.
      expect(JSON.stringify(events)).not.toContain(PROMPT_MARKER);
      const queued = outbox.claimBatch(100).map((r) => r.payload);
      for (const payload of queued) {
        expect(payload).not.toContain(PROMPT_MARKER);
        expect(payload).not.toContain(REPLY_MARKER);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
