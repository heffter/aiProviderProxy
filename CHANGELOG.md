# Changelog

## 2.0.0

The greenfield rewrite. aiproviderproxy replaces the legacy RelayPlane proxy: a
local, multi-protocol AI gateway with no cloud account and no phone-home. The
package is renamed to `aiproviderproxy` and the CLI to `aipp`.

### Added

- **Three client surfaces on one listener** — Anthropic Messages, OpenAI
  Responses (Codex), and OpenAI Chat Completions, with cross-protocol
  translation.
- **Providers** — Anthropic, OpenAI, Google (Gemini), Ollama, Z.ai (GLM), and
  eight OpenAI-compatible providers, behind a capability-aware model registry.
- **Routing** — passthrough / standard / complexity / auto / cascade modes,
  capability-preserving fallback, pre-stream retry with backoff, provider
  cooldowns, budget downgrade, account rotation, and an optional agent-routing
  policy with an offline replay tool. Every fallback is a distinct, observable,
  linked lifecycle event.
- **Local subsystems** — dashboard with an exporter-health panel, unified
  budget enforcement, alerts and anomaly detection, an exact-match response
  cache (cache hits excluded from export), a local-only mesh/memory store, and
  content-log governance.
- **Tokemetry export (optional, off by default)** — content-free usage metadata
  to a single endpoint via a durable commit-before-export outbox with
  deduplication.
- **Security** — SSRF base-URL validation, header allowlists, constant-time
  token comparison, owner-only state-file permissions, request size / JSON-depth
  limits, redaction on every diagnostic path, and an egress-allowlist test.
- **Operations** — `aipp` CLI (start, config, content-log, tokemetry, policy,
  alerts, cache, mesh, service, migrate-from-relayplane); run-at-boot service
  templates for systemd, launchd, and Windows Scheduled Tasks.

### Changed

- **Incremental client-side streaming** — a `stream: true` request is now served
  incrementally on every surface instead of being buffered. A verbatim upstream
  is forwarded byte for byte as chunks arrive; a translated upstream is decoded
  and re-encoded one frame at a time, so client time-to-first-token tracks
  upstream TTFT rather than upstream completion. Gemini and Ollama chat
  upstreams have no incremental translator and remain buffered. See
  `docs/architecture/streaming.md`.
- A streaming request's usage event is emitted when the stream ends, carrying
  the token counts from the upstream's trailing frames; previously a streamed
  response reported no usage at all.
- Two documented parity differences from the legacy proxy (both improvements):
  cache-read tokens are preserved into usage, and Anthropic thinking blocks
  surface a counts-only diagnostics header instead of being dropped.

### Fixed

- `POST /v1/messages` with `stream: true` returned a JSON body rather than an
  event stream. On a native Anthropic upstream it returned the raw SSE text
  JSON-stringified as `application/json`; on a translated upstream it fed
  upstream SSE to the object translator. No Anthropic SSE client could consume
  either.
- `POST /v1/responses` with `stream: true` on a chat upstream requested a
  streaming upstream and then parsed the resulting SSE text as a completed
  `chat.completion`.

### Removed

- The legacy standalone proxy, all RelayPlane cloud integration, remote
  mesh/osmosis sync, telemetry pings, and signup/star nudges.
- The RelayPlane-scoped npm dependencies; `better-sqlite3` is now a direct
  dependency.

### Security

- `npm audit` (production) and `trivy fs` report no HIGH/CRITICAL findings.

### Migration

- `aipp migrate-from-relayplane` imports an existing `~/.relayplane` install. The
  old state directory is left untouched for rollback. See `docs/migration.md`.

## v1.9.0 (2026-04-02)

### Features

**Multi-account token pooling** (`packages/proxy`) — transparently pool multiple Anthropic API keys / Claude Max OAT tokens and select the best available one per request.

- **Auto-detect incoming tokens**: tokens sent by Claude Code, Cursor, or any client via `Authorization: Bearer` are registered in the pool automatically (priority 10). Zero config change required for single-account users.
- **Explicit config accounts**: add additional tokens under `providers.anthropic.accounts[]` in `~/.relayplane/config.json` (priority 0 by default = tried first). Perfect for users with 2+ Claude Max subscriptions.
- **Smart selection**: pool skips rate-limited tokens and proactively throttles at 90% of the known upstream RPM limit. Ties broken by fewest requests this minute.
- **Transparent 429 retry**: if the selected token receives a 429, the proxy immediately retries with the next available token. Accurate `retry-after` is returned to the client only when all tokens are exhausted.
- **Learn from headers**: `anthropic-ratelimit-requests-limit`, `anthropic-ratelimit-requests-remaining`, and `retry-after` headers are observed on every response to keep per-token rate-limit state fresh.
- **Status endpoint**: `GET /v1/token-pool/status` returns per-account label, priority, requests-this-minute, known RPM limit, and rate-limit expiry.
- **Dashboard widget**: new "Token Pool" collapsible section in the embedded dashboard shows live per-token status and a utilisation bar.

### Config example

```json
{
  "providers": {
    "anthropic": {
      "accounts": [
        { "label": "newmax", "apiKey": "sk-ant-oat01-...", "priority": 0 },
        { "label": "default", "apiKey": "sk-ant-oat01-...", "priority": 1 }
      ]
    }
  }
}
```

Backward compatible: single-token users (env var `ANTHROPIC_API_KEY` or incoming auth passthrough) see no behaviour change.

---

## v1.8.40 and earlier

See git log for prior release notes.
