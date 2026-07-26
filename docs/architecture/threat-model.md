# Threat model

Epic AIPP-12 (security and privacy hardening). This document records the threats
aiproviderproxy defends against, the controls in place, and the tests that
demonstrate them. The gateway runs locally by default (bound to `127.0.0.1`) and
sits between local AI agents and upstream providers.

## Trust boundaries

- **Local client → gateway.** On loopback, any local process can call the
  gateway. When bound to a non-loopback host, an access token is required
  (FR-AUTH-012).
- **Gateway → upstream provider.** The gateway sends provider credentials to a
  configured base URL. That URL is a trusted destination only after SSRF
  validation.
- **Upstream provider → gateway.** Upstream responses are untrusted input.
- **Gateway → Tokemetry (optional).** Only content-free usage metadata is
  exported, to the single configured Tokemetry endpoint.

## Threats and controls

### 1. Malicious or malformed upstream responses

Threat: a compromised or buggy upstream returns oversized SSE events, malformed
JSON, or deeply nested structures to crash or hang the gateway.

Controls:

- The SSE parsers tolerate arbitrary input: unknown events, empty data, truncated
  blocks, and non-JSON payloads are handled without throwing (fuzz-tested in
  `test/security/security-suite.test.ts`).
- Response bodies are parsed defensively (`try/catch` around `JSON.parse`), and a
  failed parse degrades to a raw-string body rather than an exception.
- No subsystem sink can block or fail the request path (bounded, failure-isolated
  queues).

### 2. Request-side denial of service

Threat: a hostile local client sends an enormous body or pathologically nested
JSON to exhaust memory or stack.

Controls:

- Every POST body is checked against a size limit (`MAX_REQUEST_BYTES`, 10 MiB)
  and a JSON nesting-depth limit (`MAX_JSON_DEPTH`, 64) **before any parse**;
  violations are rejected with a client error (NFR-SEC-008). Both limits are
  configurable via `GatewayDeps.limits`.

### 3. Hostile local-network clients (token-exposed deployment)

Threat: when the gateway is bound to a non-loopback address, a network attacker
attempts to reach management, dashboard, or memory endpoints.

Controls:

- Startup refuses a non-loopback host without an access token (FR-AUTH-012).
- Management, dashboard, and memory endpoints require loopback or a matching
  access token, compared in constant time (`timingSafeEqualStr`).
- Model endpoints keep provider-passthrough semantics; the proxy token is
  accepted additively, never logged.

### 4. SSRF via provider base URLs

Threat: a configured base URL points the gateway (and its credentials) at an
internal service — cloud metadata (169.254.169.254), localhost, or an RFC-1918
address.

Controls:

- Base URLs are validated at config load: https required, no embedded
  credentials, no non-http(s) schemes, and private/loopback/link-local hosts
  require an explicit per-provider `allowPrivateNetwork` opt-in
  (NFR-SEC-003/004).

### 5. Credential and content leakage

Threat: secrets or private prompt/response content leak into logs, error
responses, the DLQ, or telemetry.

Controls:

- A central redaction module drops values under sensitive keys and masks
  credential-shaped substrings; DLQ error records are redacted before storage
  (FR-AUTH-004). A source guard test fails if new code stringifies a
  config/headers/credential object directly.
- Canonical usage events are content-free by construction; prompt/response
  content lives only in the local history log, gated by `contentLog` and stored
  owner-only.
- Client-facing error responses carry generic messages, never the upstream body.
- Request/response headers are allowlisted in both directions.

### 6. Unwanted egress (phone-home)

Threat: residual first-party phone-home behavior sends data off the machine.

Controls:

- An egress-allowlist harness intercepts all outbound calls while exercising the
  subsystems and fails on any hostname outside the configured provider base URLs
  plus the Tokemetry endpoint (NFR-SEC-009). A meta-test proves the guard flags a
  rogue fetch.

### 7. Disk exhaustion

Threat: unbounded local state files (history, cache, logs) fill the disk.

Controls:

- The history log is pruned to a retention window and entry cap on startup; the
  response cache enforces a size budget with eviction; the outbox and alert store
  prune old rows. All local state files are restricted to owner-only.

## Supply chain

- `npm audit` and `trivy fs` are run in the quality gate; the epic requires no
  HIGH/CRITICAL findings (both report 0 at sign-off).

## Follow-up actions

- None open at sign-off. Any new external dependency or new egress destination
  must extend the egress allowlist and be reflected here.
