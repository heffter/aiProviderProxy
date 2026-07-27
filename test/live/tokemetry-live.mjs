/**
 * Live Tokemetry verification (epic AIPP-13, subtask 13.4). Runs the real
 * gateway -> outbox -> batcher pipeline against a running Tokemetry server, then
 * checks mapper output + server-side dedup + query-back. NOT part of the gate.
 *
 * Usage (with the server up):
 *   TOKEMETRY_URL=http://127.0.0.1:8787 TOKEMETRY_TOKEN=tkm_... \
 *     node --import tsx test/live/tokemetry-live.mjs      (or against dist, below)
 */

import Database from 'better-sqlite3';
import { createGateway } from '../../dist/gateway/server.js';
import { buildProviderRegistry } from '../../dist/gateway/providers.js';
import {
  TokemetryOutbox,
  TokemetryBatcher,
  mapToIngest,
} from '../../dist/integrations/tokemetry/index.js';
import { httpTransport } from '../../dist/gateway/transport.js';
import { defaultConfig } from '../../dist/config/index.js';

const BASE = process.env.TOKEMETRY_URL ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.TOKEMETRY_TOKEN;
const INGEST = `${BASE}/api/v2/ingest/events`;
const MACHINE = `aipp-live-${Date.now()}`;
if (!TOKEN) throw new Error('set TOKEMETRY_TOKEN');

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-x',
  OPENAI_API_KEY: 'sk-openai-x',
};

function anthropicOk(id) {
  return JSON.stringify({
    id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 340 },
  });
}
function openaiOk(id) {
  return JSON.stringify({
    id,
    object: 'chat.completion',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 210 },
  });
}

let call = 0;
const transport = async (req) => {
  call += 1;
  const rid = `live-req-${MACHINE}-${call}`;
  const body = req.url.includes('anthropic') ? anthropicOk(rid) : openaiOk(rid);
  return { status: 200, headers: { 'request-id': rid, 'x-request-id': rid }, body };
};

const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
const gateway = createGateway({
  config: defaultConfig(),
  registry: buildProviderRegistry({ env }),
  transport,
  outbox,
});

function msg(path, model, extra = {}) {
  const isChat = path === '/v1/chat/completions';
  const body = isChat
    ? { model, messages: [{ role: 'user', content: 'hi' }], ...extra }
    : path === '/v1/responses'
      ? { model, input: 'hi', ...extra }
      : { model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra };
  return {
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': `sess-${MACHINE}` },
    body: JSON.stringify(body),
  };
}

const log = (...a) => console.log('[live]', ...a);

async function main() {
  log('machine', MACHINE);

  // Part A: run one request per client surface through the real pipeline.
  const r1 = await gateway.handle(msg('/v1/messages', 'claude-sonnet-4-5'));
  const r2 = await gateway.handle(msg('/v1/chat/completions', 'gpt-4o'));
  const r3 = await gateway.handle(msg('/v1/responses', 'gpt-4o'));
  log('surface responses:', r1.status, r2.status, r3.status);
  log('outbox pending after 3 surfaces:', outbox.counts().pending);

  // Part B: drain the outbox to the REAL server via the batcher.
  const batcher = new TokemetryBatcher(
    { endpoint: INGEST, token: TOKEN, mapperConfig: { machine: MACHINE, proxyVersion: '2.0.0' } },
    { outbox, transport: httpTransport },
  );
  const flush = await batcher.flushOnce();
  log('flush result:', JSON.stringify(flush));

  // Part C: mapper + server-side dedup via a direct POST of the SAME event twice.
  const sample = {
    schemaVersion: 1, eventId: `dedup-${MACHINE}`, logicalRequestId: 'lr', attemptId: 'at',
    eventKind: 'attempt', finality: 'final', sequence: 0,
    timestampStarted: '2026-07-27T12:00:00.000Z', timestampCompleted: '2026-07-27T12:00:01.000Z',
    clientProtocol: 'anthropic_messages', upstreamProtocol: 'anthropic',
    provider: 'anthropic', requestedModel: 'claude-sonnet-4-5', routedModel: 'claude-sonnet-4-5', nativeModel: 'claude-sonnet-4-5',
    inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteShortTokens: 0, cacheWriteLongTokens: 0,
    success: true, outcome: 'success', latencyMs: 12, streaming: false, toolCallCount: 0,
    routing: { attemptIndex: 0 }, provenance: 'provider_reported', extra: {},
  };
  const ingest = mapToIngest(sample, { machine: MACHINE, proxyVersion: '2.0.0' });
  const post = () =>
    fetch(INGEST, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ schema_version: 2, events: [ingest] }),
    }).then((r) => r.json());
  const d1 = await post();
  const d2 = await post();
  log('dedup POST #1:', JSON.stringify(d1));
  log('dedup POST #2:', JSON.stringify(d2));

  // Part D: query the server back for this machine.
  const usage = await fetch(`${BASE}/api/v2/usage?machine=${MACHINE}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => (r.ok ? r.json() : { status: r.status }));
  log('query /api/v2/usage?machine=', JSON.stringify(usage).slice(0, 400));

  const pass =
    flush.exported === 3 &&
    d1.accepted === 1 &&
    d2.duplicate === 1;
  log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('[live] ERROR', e);
  process.exit(1);
});
