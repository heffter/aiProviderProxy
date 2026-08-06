# Tokemetry integration

Tokemetry is the optional usage-metrics backend. When enabled, the gateway
exports **content-free** usage metadata (model, token counts, cost estimate,
latency, routing) for each request to a single configured Tokemetry endpoint.
Prompts and responses are never included. Export is **off by default**.

## Enabling the exporter

```jsonc
{
  "integrations": {
    "tokemetry": {
      "enabled": true,
      "baseUrl": "https://tokemetry.example",
      "credential": { "type": "env", "name": "TOKEMETRY_API_KEY" },
      "machine": "my-laptop",
      "project": { "mode": "hash" },
    },
  },
}
```

- `baseUrl` — the Tokemetry ingest endpoint (the only export destination).
- `credential` — an env-var or file reference; never embedded in config.
- `machine` — the machine identity reported with each event (enrollment).
- `project.mode` — how the project dimension is reported: `raw`, `alias`,
  `hash` (default), or `omit`.

## How export works

- Every usage event is committed to a durable local **outbox** (SQLite) before
  any network attempt — commit-before-export, so nothing is lost on a crash.
- A batching exporter drains the outbox and POSTs the **v2 ingest envelope**
  (`{ "schema_version": 2, "events": [...] }`) to `POST <baseUrl>/api/v2/ingest/events`
  with a `Bearer` token. Each event is a `UsageEventV2` row (event kind, finality,
  sequence, provider request/response ids, routing, token counts); gateway-specific
  detail lives under the allowed `extra.gateway` namespace. It retries with
  backoff and dead-letters poison events. The request path never blocks on export.
- `aipp tokemetry status` shows exporter health (queue depth, exported count,
  dead-lettered count). `aipp tokemetry dlq` lists dead-lettered events; their
  stored error records are redacted.

## Deduplication

`event_id` is the provider request id when available, else a deterministic hash
of the request identity, so the same logical request is counted once even when
both the proxy and a transcript collector observe it. Snapshots of one attempt
share the `event_id`; the final wins. See
[../architecture/tokemetry-dedup.md](../architecture/tokemetry-dedup.md).

Cache hits consume no provider tokens and are excluded from export entirely.

## Machine enrollment and exporter ops

1. Set `machine` to a stable identifier per host.
2. Provide the credential via env or file (owner-only).
3. Start the gateway; the exporter runs in-process.
4. Check `aipp tokemetry status` periodically; a growing queue or non-zero DLQ
   indicates the endpoint is unreachable or rejecting events.

## Live validation

Verified end to end against a running Tokemetry server. The harness
(`test/live/tokemetry-live.mjs`, not part of the gate) drives the real
gateway -> outbox -> batcher pipeline and checks ingest, server-side dedup, and
the mapper output:

```bash
npm run build
TOKEMETRY_URL=http://127.0.0.1:8787 TOKEMETRY_TOKEN=tkm_... \
  node test/live/tokemetry-live.mjs
```

The reconciliation to the real contract happened here: the exporter now targets
the **v2** ingest endpoint (`/api/v2/ingest/events`) with the `UsageEventV2`
shape and the `extra.gateway` namespace (the earlier v1-shaped payload was a
placeholder). Idempotency is by `event_id`: re-posting the same event returns
`duplicate: 1` (one `usage_events` row).

### Live run log

| Date       | Server                    | Surfaces                  | Result                     | Dedup                                                |
| ---------- | ------------------------- | ------------------------- | -------------------------- | ---------------------------------------------------- |
| 2026-07-27 | local v2 (migration 0027) | Messages, Chat, Responses | flush exported 3/3, dead 0 | re-post same `event_id`: accepted 1 then duplicate 1 |

## Cross-source overlap check (AC-006)

The run above proves the dedup **mechanism**: one source posting the same event
twice yields `duplicate: 1`. It does not exercise the case the mechanism exists
for — the proxy **and** the Claude Code transcript collector independently
reporting the same upstream request (see
`docs/architecture/tokemetry-dedup.md`, D-002).

`test/live/tokemetry-overlap.mjs` covers that, in two modes:

```bash
npm run build

# Synthetic: the proxy report is real (driven through the actual
# gateway -> outbox -> batcher pipeline); the collector report is a stand-in
# posted with the same event_id. Needs only a server + token.
TOKEMETRY_URL=http://127.0.0.1:8787 TOKEMETRY_TOKEN=tkm_... \
  node test/live/tokemetry-overlap.mjs

# Real collector (the AC-006 run): nothing is synthesized. Run a Claude Code
# session through the gateway with the transcript collector up, then:
TOKEMETRY_URL=http://127.0.0.1:8787 TOKEMETRY_TOKEN=tkm_... \
  TOKEMETRY_MACHINE=<the machine id the session reported under> \
  node test/live/tokemetry-overlap.mjs --real-collector
```

Both modes assert the same invariant: **exactly one `usage_events` row per
shared `event_id`**. The harness prints a ready-to-paste run-log row.

The parts that do not need a server are covered in the gate by
`test/integrations/tokemetry/cross-source-overlap.test.ts`: that a provider
request id survives end to end into `event_id` (so the two sources agree on the
key at all), that two differently-shaped reports sharing an id collapse to one
row, and that a fallback hash id cannot collide with a collector report.

### Overlap run log

| Date | Mode | Result  | Notes                                                                                  |
| ---- | ---- | ------- | -------------------------------------------------------------------------------------- |
| —    | —    | not run | Blocked on a server credential (`TOKEMETRY_TOKEN`) and a running transcript collector. |
