/**
 * Live cross-source dedup overlap check (Task 18; AC-006 live overlap).
 *
 * `tokemetry-live.mjs` proves the dedup MECHANISM: re-posting the identical
 * event twice yields `duplicate: 1`. That is a single source reporting twice.
 * This harness proves the thing the mechanism exists for: **two independent
 * sources** -- the proxy and the Claude Code transcript collector -- reporting
 * the same upstream request and collapsing to exactly one `usage_events` row.
 *
 * Both sources set `event_id` to the provider request id (see
 * docs/architecture/tokemetry-dedup.md, D-002), so the server's event_id upsert
 * merges them. What this checks that a same-payload re-post cannot: the two
 * reports carry DIFFERENT dimension columns and a different `source`, which is
 * precisely the case OQ-001 is open about.
 *
 * Two modes:
 *
 *   synthetic (default) -- the proxy report is real (driven through the actual
 *     gateway -> outbox -> batcher pipeline); the collector report is a
 *     stand-in posted directly with the same event_id. Runnable as soon as a
 *     token exists. Proves the collapse and shows the server's merge policy.
 *
 *   --real-collector -- nothing is synthesized. Assumes a real Claude Code
 *     session has already been driven through the gateway with the transcript
 *     collector running. Queries the server and asserts one row per shared
 *     event_id, reporting which sources contributed. This is the AC-006 run.
 *
 * Usage:
 *   npm run build
 *   TOKEMETRY_URL=http://127.0.0.1:8787 TOKEMETRY_TOKEN=tkm_... \
 *     node test/live/tokemetry-overlap.mjs
 *   TOKEMETRY_URL=... TOKEMETRY_TOKEN=... TOKEMETRY_MACHINE=<host machine id> \
 *     node test/live/tokemetry-overlap.mjs --real-collector
 *
 * NOT part of the quality gate: it needs a running server.
 */

import Database from 'better-sqlite3';
import { createGateway } from '../../dist/gateway/server.js';
import { buildProviderRegistry } from '../../dist/gateway/providers.js';
import {
  TokemetryOutbox,
  TokemetryBatcher,
} from '../../dist/integrations/tokemetry/index.js';
import { httpTransport } from '../../dist/gateway/transport.js';
import { defaultConfig } from '../../dist/config/index.js';

const BASE = process.env.TOKEMETRY_URL ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.TOKEMETRY_TOKEN;
const INGEST = `${BASE}/api/v2/ingest/events`;
const REAL = process.argv.includes('--real-collector');
/** In real-collector mode the machine must match the host the session ran on. */
const MACHINE =
  process.env.TOKEMETRY_MACHINE ??
  (REAL ? undefined : `aipp-overlap-${Date.now()}`);

const log = (...a) => console.log('[overlap]', ...a);
const fail = (msg) => {
  console.error('[overlap] ERROR', msg);
  process.exit(1);
};

if (!TOKEN) {
  fail(
    'set TOKEMETRY_TOKEN (a live server credential; this harness cannot run without one)',
  );
}
if (REAL && !MACHINE) {
  fail(
    '--real-collector needs TOKEMETRY_MACHINE set to the machine id the session reported under',
  );
}

/** Bearer-authenticated JSON GET. */
async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    fail(`GET ${path} -> ${res.status}`);
  }
  return res.json();
}

/** Post a v2 ingest batch. */
async function ingest(events) {
  const res = await fetch(INGEST, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ schema_version: 2, events }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail(`ingest -> ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/** Pull the usage rows the server holds for a machine. */
async function usageRows(machine) {
  const body = await get(
    `/api/v2/usage?machine=${encodeURIComponent(machine)}`,
  );
  // The query API has returned rows under a few shapes across versions; accept
  // the common ones rather than pinning to one and breaking on an upgrade.
  const rows = Array.isArray(body)
    ? body
    : (body.events ?? body.rows ?? body.data ?? body.usage_events ?? []);
  if (!Array.isArray(rows)) {
    fail(
      `unexpected /api/v2/usage shape: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return rows;
}

/** Read an event id off a usage row regardless of column naming. */
const rowEventId = (row) => row.event_id ?? row.eventId ?? row.id;

/**
 * A transcript-collector-shaped report for the same upstream request.
 *
 * Deliberately NOT a copy of the proxy's payload: it carries the user-facing
 * dimensions the collector observes (project, session, requested model) and
 * omits the routing/provider detail only the proxy sees. That difference is
 * what makes this a real overlap rather than a repeat.
 */
function collectorReport(eventId, machine) {
  return {
    event_id: eventId,
    schema_version: 2,
    event_kind: 'attempt',
    finality: 'final',
    sequence: 0,
    timestamp_started: new Date(Date.now() - 1000).toISOString(),
    timestamp_completed: new Date().toISOString(),
    provider: 'anthropic',
    requested_model: 'claude-sonnet-4-5',
    input_tokens: 1200,
    output_tokens: 340,
    cache_read_tokens: 0,
    cache_write_short_tokens: 0,
    cache_write_long_tokens: 0,
    success: true,
    outcome: 'success',
    streaming: false,
    machine,
    provenance: 'local_estimate',
    source: {
      type: 'collector',
      name: 'claude-code-transcript-collector',
      version: '0.0.0-overlap-harness',
    },
    extra: {
      collector: { project: 'aiproviderproxy', session_id: 'overlap-harness' },
    },
  };
}

/** Drive one real gateway request and export it, returning its event_id. */
async function proxyReport(machine) {
  const requestId = `overlap-req-${machine}`;
  const transport = async () => ({
    status: 200,
    headers: { 'request-id': requestId, 'x-request-id': requestId },
    body: JSON.stringify({
      id: 'msg_overlap',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1200, output_tokens: 340 },
    }),
  });
  const outbox = new TokemetryOutbox({ database: new Database(':memory:') });
  const gateway = createGateway({
    config: defaultConfig(),
    registry: buildProviderRegistry({
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-x' },
    }),
    transport,
    outbox,
  });
  const res = await gateway.handle({
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-claude-code-session-id': `sess-${machine}`,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  if (res.status !== 200) {
    fail(`gateway returned ${res.status}`);
  }
  const batcher = new TokemetryBatcher(
    {
      endpoint: INGEST,
      token: TOKEN,
      mapperConfig: { machine, proxyVersion: '2.0.0' },
    },
    { outbox, transport: httpTransport },
  );
  const flush = await batcher.flushOnce();
  log('proxy flush:', JSON.stringify(flush));
  if (flush.exported !== 1) {
    fail(`expected the proxy to export 1 event, got ${JSON.stringify(flush)}`);
  }
  // event_id is the provider request id (FR-USAGE-003).
  return requestId;
}

async function runSynthetic() {
  log('mode: synthetic collector report');
  log('machine', MACHINE);

  const eventId = await proxyReport(MACHINE);
  log('shared event_id (provider request id):', eventId);

  const result = await ingest([collectorReport(eventId, MACHINE)]);
  log('collector ingest:', JSON.stringify(result));

  const rows = await usageRows(MACHINE);
  const matching = rows.filter((r) => rowEventId(r) === eventId);
  log(
    `rows for this event_id: ${matching.length} (of ${rows.length} for the machine)`,
  );
  if (matching.length === 1) {
    log('merged row:', JSON.stringify(matching[0]).slice(0, 600));
  }

  // The collector report must be recognised as a duplicate of the proxy's, and
  // the server must hold exactly one row for the shared event_id.
  const collapsed =
    (result.duplicate ?? 0) === 1 && (result.accepted ?? 0) === 0;
  const single = matching.length === 1;
  if (!collapsed) {
    log('NOTE: the collector report was accepted as new rather than deduped.');
  }
  const pass = collapsed && single;
  log(pass ? 'RESULT: PASS (two sources -> one row)' : 'RESULT: FAIL');
  log(
    'run-log row:',
    `| ${new Date().toISOString().slice(0, 10)} | ${BASE} | synthetic collector | ` +
      `${pass ? 'one row per shared event_id' : 'FAILED'} | proxy+collector event_id ${eventId} |`,
  );
  process.exit(pass ? 0 : 1);
}

async function runRealCollector() {
  log('mode: real transcript collector (AC-006)');
  log('machine', MACHINE);
  log(
    'assumes a Claude Code session has already run through the gateway with the collector up',
  );

  const rows = await usageRows(MACHINE);
  log('rows returned for machine:', rows.length);
  if (rows.length === 0) {
    fail(
      'no usage rows for this machine -- run a Claude Code session through the gateway first',
    );
  }

  // Any event_id appearing more than once means the collapse did NOT happen.
  const counts = new Map();
  for (const row of rows) {
    const id = rowEventId(row);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1);

  // Rows naming both sources are the ones that actually overlapped.
  const overlapped = rows.filter((r) => {
    const sources = JSON.stringify(r.sources ?? r.source ?? '');
    return (
      sources.includes('aiproviderproxy') &&
      /collector|transcript/i.test(sources)
    );
  });

  log('distinct event_ids:', counts.size);
  log('event_ids with more than one row:', duplicated.length);
  log('rows naming both sources:', overlapped.length);
  if (duplicated.length > 0) {
    log('DUPLICATED:', JSON.stringify(duplicated.slice(0, 10)));
  }
  if (overlapped.length === 0) {
    log(
      'NOTE: no row names both sources. Either the collector was not running, or the',
    );
    log(
      '      server does not expose a sources set -- inspect a row and confirm manually:',
    );
    log('     ', JSON.stringify(rows[0]).slice(0, 400));
  }

  const pass = duplicated.length === 0;
  log(
    pass
      ? 'RESULT: PASS (exactly one usage_events row per event_id)'
      : 'RESULT: FAIL (an event_id has more than one row)',
  );
  log(
    'run-log row:',
    `| ${new Date().toISOString().slice(0, 10)} | ${BASE} | real collector | ` +
      `${counts.size} event_ids, ${duplicated.length} duplicated | ` +
      `${overlapped.length} rows naming both sources |`,
  );
  process.exit(pass ? 0 : 1);
}

const main = REAL ? runRealCollector : runSynthetic;
main().catch((e) => {
  console.error('[overlap] ERROR', e);
  process.exit(1);
});
