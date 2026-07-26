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
- A batching exporter drains the outbox, retries with backoff, and dead-letters
  poison events. The request path never blocks on export.
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

A live end-to-end validation (representative traffic across all three surfaces,
verifying priced, deduplicated events via the Tokemetry query API, including the
transcript-collector overlap scenario) is tracked as a post-deployment
verification and recorded here once the Tokemetry server is available. Until
then, the mock-based tests in `test/integrations/tokemetry/` stand in as
evidence.

### Live run log

| Date        | Machine | Surfaces | Dedup verified | Notes                                |
| ----------- | ------- | -------- | -------------- | ------------------------------------ |
| _(pending)_ |         |          |                | Awaiting a deployed Tokemetry server |
