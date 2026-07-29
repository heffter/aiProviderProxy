# Content logging (local request history)

aiproviderproxy keeps a local request history at `history.jsonl` in the config
home (`~/.aiproviderproxy/` by default, or `$AIPP_HOME`). Every request records
content-free metadata — provider, model, token counts, latency, cost estimate.

**When content logging is ON (the default), the full prompt and response content
of each request is also written to that file.** This is convenient for
inspecting and debugging traffic in the dashboard, but it means your prompts and
model outputs are stored on disk.

This data is **local only**. It is never sent anywhere: it is not part of the
canonical usage event, and it is never included in Tokemetry export.

## What is stored

For each successful request the **winning attempt's** request and response
bodies are captured (all three surfaces: Messages, Responses, Chat
Completions). Before they are written they are:

- **Redacted** — credential-shaped strings (API keys, bearer tokens) and values
  under sensitive keys (`authorization`, `apiKey`, `password`, …) are removed,
  the same redaction the diagnostic paths use.
- **Bounded** — a body that exceeds the request size (10 MiB) or JSON-depth (64)
  limits is replaced by a small `{ "omitted": "…" }` marker rather than stored
  verbatim, so the log stays cheap to write and read.

Failed requests and cache hits record metadata only (there is no winning
upstream exchange to store).

## Where and for how long

- **File:** `<home>/history.jsonl` (owner-only permissions, `0600`, where the
  platform supports it).
- **Retention:** entries are pruned to `contentLog.retentionDays` (default 7)
  and capped at `contentLog.maxEntries` (default 10000). Pruning runs on gateway
  startup.

## Turning it on or off

```bash
aipp content-log status   # show state + this disclosure
aipp content-log off      # stop storing prompt/response content
aipp content-log on       # resume storing content
```

`off` keeps the metadata history but stops writing prompt and response content.

## Configuration

```jsonc
{
  "contentLog": {
    "enabled": true, // store full prompt/response content
    "retentionDays": 7, // prune entries older than this
    "maxEntries": 10000, // cap the number of retained entries
  },
}
```

On first run the gateway prints a one-time notice pointing at this behavior and
how to disable it.
