# Product Requirements Document: aiProviderProxy Multi-Protocol AI Gateway and Tokemetry Export

**Document ID:** PRD-AIPP-001
**Status:** Approved for implementation
**Version:** 2.0
**Date:** 2026-07-12
**Repository:** `heffter/aiProviderProxy` (private fork of `RelayPlane/proxy` v1.9.38)
**Primary consumer:** Claude Task Master
**Companion project:** `C:\devel\tokemetry` (design spec `docs/superpowers/specs/2026-07-09-tokemetry-design.md`)
**Current-state evidence:** `docs/architecture/protocol-conformance-baseline.md`

---

## 1. Executive Summary

aiProviderProxy is rebuilt as **aiproviderproxy** (CLI binary `aipp`): a local-first, multi-protocol AI gateway that exposes the protocol surfaces required by modern AI coding agents (Claude Code, Codex, OpenAI-SDK tools) and routes them to interchangeable upstream providers, while exporting normalized, content-free usage events to the self-hosted Tokemetry observability system.

The project is a **greenfield gateway built inside the existing repository** (Decision D-009). The current 7,698-line `standalone-proxy.ts` monolith remains the live server, startable via `aipp start --legacy`, until a parity harness proves the new gateway equivalent on a recorded fixture corpus; then the legacy implementation is deleted.

Version 2.0 of this document replaces version 1.0 entirely. It is grounded in a completed source audit (see the conformance baseline document) and in ten decisions (Section 20) resolved with the product owner on 2026-07-12.

Scope highlights:

1. Anthropic-compatible `POST /v1/messages` with **full cross-protocol translation**: Claude Code can be routed to GLM (Z.ai) or OpenAI-compatible models, not only to Anthropic (D-003).
2. OpenAI-compatible `POST /v1/responses` for Codex — this surface does not exist today and is built from scratch.
3. OpenAI-compatible `POST /v1/chat/completions` reimplemented on the new canonical stack, fixing known fidelity gaps (dropped thinking blocks, dropped cache-token usage).
4. Typed provider adapters: Anthropic, OpenAI, Z.ai (GLM), Google Gemini, Ollama, and a generic OpenAI-compatible adapter for xAI, OpenRouter, DeepSeek, Groq, Mistral, Together, Fireworks, and Perplexity.
5. Durable, idempotent, privacy-preserving export of usage events to Tokemetry through a SQLite outbox, targeting Tokemetry's real ingest contract.
6. Complete removal of all RelayPlane cloud integration (telemetry upload, lifecycle pings, version-check pings, signup nudges, claim flow, swarm client, mesh remote sync) (D-001).
7. Full product rename: package `aiproviderproxy`, binary `aipp`, state directory `~/.aiproviderproxy`, env prefix `AIPP_*`, with a one-time importer from `~/.relayplane` (D-008).
8. Security hardening: loopback-by-default with mandatory access token for non-loopback binding, central secret redaction, SSRF-guarded base URLs, header allowlists (D-007).

The proxy is authoritative for request execution, routing decisions, lifecycle timing, and upstream response metadata. Tokemetry is authoritative for durable usage history, cost computation, limits, analytics, and alerting.

---

## 2. Current State (audited 2026-07-12)

The full evidence-based audit lives in `docs/architecture/protocol-conformance-baseline.md`. Facts that shape this PRD:

- The live server is `src/standalone-proxy.ts` (7,698 lines, raw `node:http`, default `127.0.0.1:4100` via CLI). A second `ProxyServer` in `src/server.ts` is unreachable from the CLI and broken for Anthropic; it and five optional `@relayplane/*` packages are dead weight.
- `POST /v1/messages` exists as a high-fidelity **Anthropic-only passthrough** (verbatim SSE byte forwarding, side-channel usage parse). It cannot route to non-Anthropic upstreams.
- `POST /v1/responses` **does not exist**.
- `POST /v1/chat/completions` exists with OpenAI-to-Anthropic/Gemini translation, but silently drops `thinking` blocks and cache-token usage on the Anthropic path and has no extended-thinking or `cache_control` support.
- Providers are hardcoded `switch` dispatch. Four declared providers (mistral, together, fireworks, perplexity) have no dispatch case and would **misroute to api.openai.com**.
- Provider request IDs (Anthropic `request-id`, OpenAI `x-request-id`) are captured nowhere. The Anthropic `cache_creation.ephemeral_5m/1h` split is not extracted (only the aggregate).
- Four independent config schemas read the same `~/.relayplane/config.json`; only one has versioning (v4).
- No redaction utility exists. No client-to-proxy authentication exists on model endpoints. Full prompts/responses are persisted to `history.jsonl` by default (undocumented).
- Phone-home: lifecycle pings default-on, version-check pings ungated by telemetry flags, a signup nudge auto-starts a device-auth flow, mesh sync targets a dev Fly.io URL.
- Dead code: `server.ts`, `streaming.ts`, `tenant-isolation.ts`, `kill-switch.ts`, `credential-pool.ts`, `cost-ledger.ts`, `recovery.ts`, `recovery-mesh.ts`, `recovery-mesh-server.ts`, `helpers/config-loader.ts`, `credentials.ts` (module unused; logic duplicated inline in four files).

---

## 3. Problem Statement

AI developer tools depend on incompatible provider protocols and provider-specific semantics:

- Claude Code uses Anthropic Messages; Codex custom providers use the OpenAI Responses wire protocol; most other tools use OpenAI Chat Completions.
- Z.ai exposes an OpenAI-compatible interface with GLM-specific controls (`thinking`, `reasoning_effort`, `tool_stream`).
- Providers report caching, reasoning, tool usage, service tiers, and usage counters differently.
- Streaming protocols are superficially similar but structurally different.
- Model aliases change independently of stable provider model identifiers.

The current proxy forwards bytes competently for one protocol pair but cannot safely normalize this ecosystem: translation gaps silently lose data, provider dispatch is unmaintainable, and usage accounting never leaves the machine in a durable, queryable form. Separately, the Tokemetry project needs a source of usage events for traffic that Claude Code transcripts cannot see (OpenAI, Z.ai, fallbacks, latency).

---

## 4. Product Vision

One local endpoint that AI coding tools use regardless of their native API protocol, retaining provider-specific capabilities, and producing complete, trustworthy, content-free operational telemetry for the owner's Tokemetry instance.

```text
Claude Code ── Anthropic Messages ─┐
Codex ─────── OpenAI Responses ────┼──> aiproviderproxy (aipp, 127.0.0.1:4100)
Other tools ─ Chat Completions ────┘          │
                                              ├── Canonical request lifecycle
                                              ├── Routing and policy engine
                                              ├── Provider adapters (typed registry)
                                              ├── Budget, cache, alerts, tool authorization
                                              ├── Local dashboard, traces, history
                                              └── Durable Tokemetry outbox
                                                       │
                                                       ▼
                                          Tokemetry (self-hosted, WireGuard-only VPS)
```

---

## 5. Goals

### 5.1 Primary Goals

- G-001: Support the three client protocol surfaces (Anthropic Messages, OpenAI Responses, OpenAI Chat Completions) without client-side patches.
- G-002: Route any client protocol to any capable provider through a provider-neutral canonical lifecycle, including Anthropic Messages clients to OpenAI-protocol upstreams (D-003).
- G-003: Preserve provider-specific capabilities rather than reducing to a lowest common denominator.
- G-004: Support streamed and non-streamed responses with correct client-facing event semantics, validated by state-machine encoders and fixtures.
- G-005: Generate one normalized usage event for every terminal upstream attempt and one local logical-request summary per client request.
- G-006: Export usage events to Tokemetry's real ingest API without adding availability dependencies to request execution.
- G-007: Make export crash-safe, offline-safe, idempotent, and content-free.
- G-008: Remove every RelayPlane cloud integration and rename the product (D-001, D-008).
- G-009: Make adding a provider or protocol adapter a bounded, testable change.
- G-010: Prove parity with the legacy proxy on a recorded fixture corpus before cutover, then delete the legacy implementation (D-009).

### 5.2 Secondary Goals

- G-011: Keep the valuable local subsystems working on the new stack: dashboard, budget enforcement, alerts/anomaly detection, deny-by-default tool authorization (extended to all surfaces), response cache, and the local-only mesh/osmosis learning stores (D-005).
- G-012: Support model capabilities: reasoning, tools, structured output, multimodal input, prompt caching, long context.
- G-013: Expose routing and failure metadata rich enough for Tokemetry to analyze fallbacks and provider reliability.
- G-014: Provide operational CLI commands and health endpoints for the exporter (status, flush, DLQ, test-connection).
- G-015: Align internal telemetry with OpenTelemetry GenAI semantic conventions without requiring an OTel collector.

---

## 6. Non-Goals

- NG-001: The proxy is not the source of truth for provider pricing; it sends no cost to Tokemetry (proxy estimates go to `extra` for reconciliation only).
- NG-002: No prompt, response, tool-argument, file-path, or code content is ever exported to Tokemetry.
- NG-003: No feature parity guarantee across every provider in the first release.
- NG-004: No multi-tenant SaaS control plane; this is a single-operator, private tool (D-004).
- NG-005: No proxying of provider subscription plans where provider terms do not clearly permit it; Z.ai Coding Plan support stays behind an unimplemented, default-off flag pending a compliance decision.
- NG-006: No MCP server execution normalization in this release (the lifecycle reserves a `tool_origin` dimension for later).
- NG-007: No semantic quality evaluation or automated model grading.
- NG-008: No duplication of Tokemetry dashboards, pricing history, or alerting.
- NG-009: Hidden reasoning text is never exposed to clients that did not request it and never transmitted to telemetry.
- NG-010: No conformance claims without fixture tests.
- NG-011: No npm publication; the package is private (D-004).
- NG-012: No backward-compatibility obligation to external RelayPlane users; the only migration supported is the owner's own `~/.relayplane` state (D-004).

---

## 7. Users and Personas

Single primary operator (the repository owner) wearing several hats across a personal multi-machine fleet (Windows primary, Linux, macOS):

- **AI developer:** uses Claude Code (Max subscription), Codex, and OpenAI-SDK tools against one local gateway.
- **Platform operator:** configures providers, credentials, routing policies, budgets, and the Tokemetry integration; runs the proxy as an OS service.
- **Privacy owner:** requires local-first operation, no phone-home, content-free export, and secret redaction.
- **Maintainer:** needs bounded modules, protocol fixtures, strict TypeScript, and quality gates (ESLint, Prettier, vitest coverage, trivy).

Third-party personas (FinOps teams, external users) are explicitly out of scope (D-004).

---

## 8. Key User Stories

- US-001: As a Claude Code user, I point `ANTHROPIC_BASE_URL` at `http://127.0.0.1:4100` and use Anthropic Messages without protocol breakage.
- US-002: As a Claude Code user, I can route selected requests to GLM or OpenAI models and still receive valid Anthropic SSE streams, including tool use.
- US-003: As a Codex user, I configure aiproviderproxy as a custom provider with `wire_api = "responses"` and complete real workflows.
- US-004: As an OpenAI SDK user, Chat Completions continue to work, now without silent usage/thinking data loss.
- US-005: As the operator, I configure Z.ai's standard API and use `glm-5.2`.
- US-006: As the operator, I can see exactly which provider, model, account, and attempt served each request, and why fallbacks happened.
- US-007: As the privacy owner, I can prove Tokemetry export contains no prompt or response content (snapshot tests, audit mode).
- US-008: As the operator, I can restart the proxy during a Tokemetry outage without losing usage events.
- US-009: As the maintainer, I add a provider without touching HTTP routing code.
- US-010: As the operator, my Tokemetry dashboard shows proxy-observed OpenAI/Z.ai usage that transcripts cannot see, without double-counting Claude Code traffic that both the proxy and the transcript collector report.
- US-011: As the operator, I migrate from `~/.relayplane` with one command and my budgets, routing config, and history survive.
- US-012: As the maintainer, deterministic protocol conformance fixtures run in CI.

---

## 9. Product Principles

- PP-001: Protocol adapters and provider adapters are separate concepts.
- PP-002: Preserve native capabilities and metadata; namespaced extensions over silent dropping.
- PP-003: Normalize lifecycle metadata, never prompt content.
- PP-004: Never block a model response on telemetry availability.
- PP-005: Persist before asynchronous export.
- PP-006: Prefer stable provider request IDs for event identity; they are also the cross-source deduplication key in Tokemetry.
- PP-007: Retries, fallbacks, account rotations, and downgrades are distinct, first-class, typed events.
- PP-008: Unsupported capability behavior is explicit (structured error or configured stripping with diagnostics), never silent.
- PP-009: One configuration schema, one loader, versioned and migratable.
- PP-010: Conservative security defaults; loopback-only unless a token is configured.
- PP-011: Pricing in the proxy is advisory; pricing in Tokemetry is authoritative.
- PP-012: Protocol compatibility is validated through fixtures and real-client smoke tests.
- PP-013: The legacy proxy is the behavioral reference until the parity harness passes; regressions against it are bugs.

---

## 10. Target Architecture

### 10.1 Greenfield layout and coexistence

New code is built in the target structure below while legacy flat files in `src/` remain untouched and runnable (`aipp start --legacy`). The cutover epic (AIPP-13) deletes the legacy files after parity validation.

```text
src/
  gateway/
    server.ts               # thin HTTP shell: listener, auth, dispatch to protocol registry
    router.ts               # path -> protocol adapter resolution
  protocols/
    registry.ts
    canonical.ts            # canonical request/response/stream types
    anthropic-messages/     # request parse/validate, response encode, SSE state machine, errors
    openai-responses/
    openai-chat/
  providers/
    registry.ts
    types.ts                # ProviderAdapter contract
    openai-compatible.ts    # generic adapter (xai, openrouter, deepseek, groq, mistral, together, fireworks, perplexity)
    anthropic/  openai/  zai/  google/  ollama/
  models/
    registry.ts  capabilities.ts  aliases.ts
  lifecycle/
    request-context.ts  attempt.ts  usage-event.ts  event-sinks.ts
  routing/
    engine.ts  complexity.ts  cascade.ts  policy.ts  downgrade.ts
  integrations/tokemetry/
    config.ts  mapper.ts  outbox.ts  exporter.ts  batcher.ts  retry.ts  dlq.ts  health.ts
  ops/                      # ported subsystems, consuming lifecycle events
    dashboard/  budget/  alerts/  anomaly/  cache/  tool-router/  mesh/  trackers/
  config/
    schema.ts  loader.ts  migrate-relayplane.ts  redact.ts
  cli/
    index.ts  tokemetry.ts  service.ts  ...
docs/
  architecture/   # baseline, lifecycle, provider contract, tokemetry export
  integrations/   # claude-code.md, codex.md, zai.md, tokemetry.md
test/
  fixtures/{anthropic,openai-responses,openai-chat,zai}/
  conformance/  integration/  e2e/  chaos/  parity/
```

### 10.2 Separation of responsibilities

- **Protocol adapter:** client-facing request parsing/validation, protocol semantics, stream event encoding (state machine), error formatting, conformance version.
- **Canonical lifecycle:** logical request identity, attempt identity, timing, selected model, routing context, terminal status, normalized usage; event fan-out to sinks.
- **Provider adapter:** upstream URL construction, authentication, request serialization, stream parsing, response parsing, error classification, usage extraction (including cache TTL split and provider request IDs), health checks.
- **Routing engine:** model selection, capability filtering, account selection, fallback ordering, budget rules, policy decisions.
- **Tokemetry exporter:** canonical event to ingest payload mapping, durable queueing, batching, retry, DLQ, health.
- **Ops subsystems:** dashboard, budget, alerts, anomaly, cache, tool authorization, mesh/osmosis, session/agent/trace/routing-log trackers — all consume lifecycle events through sinks; none may block the request path.

### 10.3 Parity and cutover strategy

- A recorded, sanitized fixture corpus (captured from real traffic during Epic AIPP-1) is replayed through both stacks; responses, stream event sequences, and usage numbers are diffed.
- The new gateway becomes the default in `aipp start` only when the parity suite passes and Claude Code plus Codex smoke tests succeed.
- `--legacy` and the legacy files are removed in the same release that documents cutover (AIPP-13).

---

## 11. Functional Requirements

### 11.1 Protocol Registry and Canonical Lifecycle

- FR-PROTO-001: Protocol handlers MUST register through a protocol registry; no monolithic request handler.
- FR-PROTO-002: Each protocol adapter MUST declare route paths, request schema version, streaming support, tool support, multimodal support, and response encoder.
- FR-PROTO-003: Every accepted client request MUST receive a stable `logical_request_id`.
- FR-PROTO-004: Every upstream call MUST receive a unique `attempt_id`.
- FR-PROTO-005: The lifecycle MUST retain requested model, routed model, and native upstream model.
- FR-PROTO-006: The lifecycle MUST retain client protocol and upstream protocol.
- FR-PROTO-007: The lifecycle MUST retain selected provider, account label where safe, routing policy, fallback reason, and attempt index.
- FR-PROTO-008: Terminal states MUST include success, client_cancelled, upstream_error, timeout, policy_rejected, validation_error, internal_error.
- FR-PROTO-009: The lifecycle MUST support progressive usage snapshots for streaming responses.
- FR-PROTO-010: The final usage event MUST identify whether counters are provider-reported or locally estimated.
- FR-PROTO-011: Non-normalizable protocol fields MUST be preserved in namespaced metadata.
- FR-PROTO-012: Request and response bodies MUST NOT enter canonical telemetry events.
- FR-PROTO-013: Lifecycle hooks (sinks) MUST be independent; one sink's failure MUST NOT affect another or the client response (FR-PROTO-014).
- FR-PROTO-015: Each protocol adapter carries a conformance version reported in diagnostics.

### 11.2 Anthropic Messages Surface (`POST /v1/messages`)

- FR-ANTH-001: Expose `POST /v1/messages` and `POST /v1/messages/count_tokens`.
- FR-ANTH-002: Validate required fields and headers while allowing supported beta headers; strip OAT-unsupported beta flags exactly as the legacy proxy does.
- FR-ANTH-003: Support string and structured content blocks, including image and document blocks toward capable upstreams.
- FR-ANTH-004: Support system prompt blocks.
- FR-ANTH-005: Support Anthropic tools and tool_choice.
- FR-ANTH-006: Support non-streamed responses.
- FR-ANTH-007: Support Anthropic SSE streaming with correct event order and types (`message_start`, `content_block_start`, `content_block_delta` incl. `text_delta`/`input_json_delta`/`thinking_delta`/`signature_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`), produced by a state-machine encoder with fixture tests.
- FR-ANTH-008: **Anthropic upstream fast path:** when the routed provider is Anthropic, preserve the legacy verbatim passthrough behavior (byte-identical body forwarding, verbatim SSE relay, side-channel usage parse). Parity with legacy is mandatory.
- FR-ANTH-009: **Translation path (D-003):** when the routed provider is OpenAI-protocol (OpenAI, Z.ai, generic-compatible), translate canonical request to the upstream protocol and re-encode responses/streams as valid Anthropic SSE, including streamed tool-use blocks assembled from OpenAI tool-call deltas.
- FR-ANTH-010: Map upstream reasoning output (GLM `reasoning_content`, OpenAI reasoning summaries where exposed) to Anthropic `thinking` blocks where representable; otherwise omit with a namespaced diagnostic. Never fabricate signatures.
- FR-ANTH-011: Preserve extended-thinking controls toward Anthropic; translate `thinking` budget to GLM/OpenAI reasoning controls where supported; otherwise apply capability validation (explicit error or configured stripping).
- FR-ANTH-012: Preserve prompt-caching directives toward Anthropic; strip with diagnostics toward providers without caching directives.
- FR-ANTH-013: Capture provider request ID (`request-id` header) and message ID on every attempt.
- FR-ANTH-014: Extract cache counters including the `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` split when reported.
- FR-ANTH-015: Capture service tier and stop reason when reported.
- FR-ANTH-016: Cancel the upstream request on client disconnect where safe.
- FR-ANTH-017: Fixture tests for text, tools, thinking, caching, errors, streaming, and translation to at least one OpenAI-protocol upstream.

### 11.3 OpenAI Responses Surface (`POST /v1/responses`)

- FR-RESP-001: Expose `POST /v1/responses` (new; nothing exists today).
- FR-RESP-002: Support Codex custom-provider usage (`wire_api = "responses"`).
- FR-RESP-003: Support text input and structured input items.
- FR-RESP-004: Support streamed and non-streamed responses.
- FR-RESP-005: Encode Responses streaming event types in valid order (`response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`, `response.function_call_arguments.delta`, terminal `response.completed`/`response.failed`/`response.incomplete`) via a state-machine encoder with fixtures.
- FR-RESP-006: Support function tools.
- FR-RESP-007: SHOULD support structured outputs when the upstream capability allows.
- FR-RESP-008: Support reasoning-effort controls; retain reasoning-token counters; never export reasoning text.
- FR-RESP-009: Support response status, incomplete details, output items, and terminal events.
- FR-RESP-010: Preserve client-supplied metadata within privacy limits.
- FR-RESP-011: Hosted tools (web_search, file_search, code_interpreter, computer_use) MUST fail explicitly or pass through only when the direct upstream executes them; the proxy never fakes them (FR-RESP-012).
- FR-RESP-013: Extract cached-input counters when present.
- FR-RESP-014: Capture provider response and request IDs.
- FR-RESP-015: Ship a documented Codex `config.toml` example (docs/integrations/codex.md).
- FR-RESP-016: Include an end-to-end Codex smoke test.
- FR-RESP-017: Support non-OpenAI upstreams through canonical translation (Responses client to Chat-protocol upstream), capability-gated.

### 11.4 OpenAI Chat Completions Surface (`POST /v1/chat/completions`)

- FR-CHAT-001: Reimplement on the canonical stack with behavior parity to legacy for supported features (parity harness).
- FR-CHAT-002: Existing OpenAI-compatible clients MUST NOT require migration to Responses.
- FR-CHAT-003: Streaming and non-streaming both supported.
- FR-CHAT-004: Function/tool calling supported, including streamed tool-argument assembly.
- FR-CHAT-005: Existing model aliases keep working (see 11.10, FR-MODEL-012); `rp:`/`relayplane:` aliases remain accepted with a deprecation notice, `aipp:` equivalents added.
- FR-CHAT-006: Usage extraction feeds the canonical lifecycle; the legacy defect that dropped Anthropic cache tokens on this path MUST be fixed and regression-tested.
- FR-CHAT-007: Anthropic-upstream translation MUST NOT silently drop thinking blocks; representable content is mapped, the rest produces namespaced diagnostics.
- FR-CHAT-008: Unknown request fields are ignored only where the protocol permits; otherwise validation is explicit.
- FR-CHAT-009: `GET /v1/models` returns the model registry view.
- FR-CHAT-010: `POST /v1/estimate` (pre-flight cost estimate) is preserved.

### 11.5 Provider Adapter Framework

- FR-PROV-001: Providers register through a provider registry.
- FR-PROV-002: An adapter declares provider ID, display name, upstream protocols, base URLs, auth modes, model discovery support, and capabilities.
- FR-PROV-003: Provider IDs are canonical lowercase identifiers; aliases normalize centrally (FR-PROV-004).
- FR-PROV-005: Adapters implement request serialization, response parsing, stream parsing, error classification, usage extraction, and health checks.
- FR-PROV-006: No provider-specific code in the HTTP shell or protocol adapters.
- FR-PROV-007: Adapters support dependency injection for test fixtures (injectable fetch/transport).
- FR-PROV-008: A provider may expose multiple upstream protocols (OpenAI: chat + responses).
- FR-PROV-009: The generic OpenAI-compatible adapter serves every declared-but-unimplemented legacy provider; the legacy misroute bug (undispatch-able providers falling through to api.openai.com) MUST be impossible by construction: unknown provider IDs fail validation.
- FR-PROV-010: Provider-specific extensions use typed, namespaced extension fields.
- FR-PROV-011: Adapters declare retry safety before and after stream initiation.
- FR-PROV-012: Adapters expose retryable status codes and canonical error categories.
- FR-PROV-013: Configurable request timeouts and idle stream timeouts per provider.
- FR-PROV-014: Adapter version included in diagnostics.

### 11.6 Anthropic Provider Adapter

- FR-PA-ANTH-001: Direct API-key auth (`x-api-key`).
- FR-PA-ANTH-002: Preserve OAuth/Max token support (`sk-ant-oat*` gets `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`, OAT-unsupported beta flags stripped) and incoming-header passthrough auth, exactly as legacy.
- FR-PA-ANTH-003: Preserve multi-account token pools with 429 rotation, 401 quarantine, and header-learned rate limits; preserve hybrid auth (`useMaxForModels` patterns).
- FR-PA-ANTH-004: Capture request ID, message ID, usage (incl. 5m/1h cache split), service tier, stop reason.
- FR-PA-ANTH-005: Preserve supported beta headers.
- FR-PA-ANTH-006: Reject unsupported token/subscription modes at config validation.
- FR-PA-ANTH-007: Maintain prompt-caching block order and TTL semantics.
- FR-PA-ANTH-008: Map provider rate-limit errors to canonical categories.
- FR-PA-ANTH-009: Native streaming without full-response buffering.

### 11.7 OpenAI Provider Adapter

- FR-PA-OAI-001: API-key authentication (env or config credential reference).
- FR-PA-OAI-002: Responses as a first-class upstream protocol.
- FR-PA-OAI-003: Chat Completions upstream where required.
- FR-PA-OAI-004: Capture response ID, request ID, usage, cached input, reasoning tokens, service tier, terminal status.
- FR-PA-OAI-005: Model metadata is configuration/registry-driven, never hardcoded in handlers (FR-PA-OAI-006).
- FR-PA-OAI-007: Aliases resolve to concrete upstream model IDs.
- FR-PA-OAI-008: Hosted tools pass through only to the direct upstream; otherwise rejected.
- FR-PA-OAI-009: Stream cancellation and idle-timeout handling.
- FR-PA-OAI-010: Rate-limit headers captured in diagnostics.

### 11.8 Z.ai Provider Adapter

- FR-PA-ZAI-001: Support the documented Z.ai standard API (`https://api.z.ai/api/paas/v4`) with bearer auth.
- FR-PA-ZAI-002: Initial model set includes `glm-5.2`; `glm-5-turbo` and `glm-4.7` configurable (FR-PA-ZAI-003).
- FR-PA-ZAI-004: Use Z.ai's OpenAI-compatible surface via the adapter (extends generic-compatible).
- FR-PA-ZAI-005: Preserve GLM `thinking`, `reasoning_effort`, and `tool_stream` controls; map from Anthropic thinking / Responses reasoning controls where routed cross-protocol.
- FR-PA-ZAI-006: Capture request/response IDs, prompt/completion/cached tokens, finish reason, tool metadata.
- FR-PA-ZAI-007: GLM-specific metadata goes in a namespaced extension object.
- FR-PA-ZAI-008: Coding Plan proxying stays unimplemented behind a default-off flag pending compliance approval; standard API and Coding Plan configuration are never conflated (FR-PA-ZAI-009).
- FR-PA-ZAI-010: Streamed and non-streamed fixture tests, including reasoning-content streaming.

### 11.9 Google, Ollama, and Generic-Compatible Adapters

- FR-PA-GOO-001: Port the existing Gemini native adapter (request/response/stream translation, function calls) into the adapter framework with fixtures.
- FR-PA-OLL-001: Port the existing Ollama adapter (NDJSON to SSE, local health check) into the framework.
- FR-PA-GEN-001: The generic OpenAI-compatible adapter serves xai, openrouter, deepseek, groq, mistral, together, fireworks, and perplexity with per-provider base URL, auth env var, and model prefix rules from the registry.
- FR-PA-GEN-002: Auth passthrough (client bearer forwarded when no configured key) remains supported per provider where legacy supported it.

### 11.10 Model Registry and Capabilities

- FR-MODEL-001: Model metadata is separate from provider endpoint configuration.
- FR-MODEL-002: Registry retains provider, native model ID, aliases, lifecycle status, context limit, output limit, capability flags.
- FR-MODEL-003: Capability flags at minimum: streaming, tools, parallel tools, structured output, reasoning, prompt caching, vision input, audio input, image output, batch.
- FR-MODEL-004: Capabilities support unknown/supported/unsupported/conditional states; conditional identifies requirements (FR-MODEL-005).
- FR-MODEL-006: Routing filters candidates by required capabilities before ranking.
- FR-MODEL-007: Local overrides supported.
- FR-MODEL-008: Unknown model IDs allowed in passthrough mode with diagnostics.
- FR-MODEL-009: Aliases never silently change provider unless cross-provider routing is enabled by policy.
- FR-MODEL-010: Actual upstream model ID recorded in every terminal attempt.
- FR-MODEL-011: Metadata updates never rewrite historical events.
- FR-MODEL-012: Legacy alias tables (`MODEL_MAPPING`, smart aliases, prefix rules) migrate into the registry with equivalence tests.

### 11.11 Tool Calling

- FR-TOOLS-001: Canonical tool definitions preserve name, description, input schema, tool-choice policy.
- FR-TOOLS-002: Tool-call identifiers remain stable through protocol translation.
- FR-TOOLS-003: Streamed tool-argument fragments are assembled and emitted per client protocol (state per block index / call index).
- FR-TOOLS-004: Parallel tool calls are capability-gated.
- FR-TOOLS-005: Provider-hosted tools are never represented as client-executed functions without an explicit adapter.
- FR-TOOLS-006: Tool execution content never reaches Tokemetry; counts, categories, durations only (FR-TOOLS-007).
- FR-TOOLS-008: The deny-by-default tool authorization router (tool packs) is enforced on **all three protocol surfaces** (legacy enforced it only on `/v1/messages`).
- FR-TOOLS-009: Tool conversion failures are explicit and testable.

### 11.12 Routing, Fallback, Retry

- FR-ROUTE-001: Routing operates on canonical capability requirements.
- FR-ROUTE-002: Routing records requested model, selected model, provider, policy name, decision reason.
- FR-ROUTE-003: Cross-provider fallback is configurable, off by default where behavior can materially change.
- FR-ROUTE-004: Every fallback attempt has its own `attempt_id`; the logical request identifies the winning attempt (FR-ROUTE-005); attempts are never collapsed (FR-ROUTE-006).
- FR-ROUTE-007: Retry policy distinguishes connection failure, timeout, rate limit, overload, validation error, auth error, client cancellation.
- FR-ROUTE-008: No automatic retry after client-visible output unless the client protocol supports recovery.
- FR-ROUTE-009: Stream retries configured separately from pre-stream retries.
- FR-ROUTE-010: Fallback preserves required capabilities; incompatible model families need explicit mappings (FR-ROUTE-011).
- FR-ROUTE-012: Telemetry records fallback source, target, trigger, attempt index, terminal result (legacy recorded cascade hops only as console logs — this becomes structured data).
- FR-ROUTE-013: Budget downgrade, reliability fallback, and account rotation are distinguishable event types (FR-ROUTE-014).
- FR-ROUTE-015: Existing routing modes (passthrough, auto, cost, complexity, cascade) are ported with behavioral tests; complexity classification heuristics carry over.
- FR-ROUTE-016: The YAML agent-policy engine becomes live-enforceable behind `routing.policy.enforce` (default false); simulation/replay tooling is preserved.
- FR-ROUTE-017: Same-endpoint retry with exponential backoff and jitter is added for pre-stream connection failures (legacy had none), bounded and configurable.

### 11.13 Authentication and Secrets

- FR-AUTH-001: Upstream provider credentials are separate from the Tokemetry token and from the proxy access token.
- FR-AUTH-002: Secrets are not stored in the main config file by default; env-var and credentials-file references are supported (FR-AUTH-003).
- FR-AUTH-004: Secrets are redacted from logs, diagnostics, traces, errors, and DLQ records by a central redaction utility (new; none exists today).
- FR-AUTH-005: Incoming authorization passthrough is explicitly configured per protocol and provider.
- FR-AUTH-006: Provider auth modes are typed.
- FR-AUTH-007: Separate credentials per named provider account (token pool config carries over).
- FR-AUTH-008: Account labels exportable to Tokemetry only when enabled; never secret material.
- FR-AUTH-009: The Tokemetry token is used only for ingest.
- FR-AUTH-010: Startup validation detects missing/conflicting/unsupported credential modes.
- FR-AUTH-011: Diagnostics identify the credential source without exposing values.
- FR-AUTH-012 (D-007): The server binds `127.0.0.1` by default with no token required; binding a non-loopback host REQUIRES a configured `server.accessToken`, otherwise startup fails with an actionable error. Management/control endpoints require loopback or the token. When a token is set, model endpoints accept it via `Authorization: Bearer` in addition to provider passthrough headers.

### 11.14 Canonical Usage Event

```ts
interface CanonicalUsageEvent {
  schemaVersion: 1;
  eventId: string;                 // provider request ID when available (see FR-USAGE-003)
  logicalRequestId: string;
  attemptId: string;
  eventKind: "attempt" | "logical_request";
  finality: "snapshot" | "final";
  sequence: number;

  timestampStarted: string;        // UTC ISO-8601
  timestampFirstToken?: string;
  timestampCompleted: string;

  clientProtocol: "anthropic_messages" | "openai_responses" | "openai_chat";
  upstreamProtocol: string;

  provider: string;
  requestedModel: string;
  routedModel: string;
  nativeModel: string;

  sessionId?: string;              // X-Claude-Code-Session-Id or synthetic
  project?: string;
  machine?: string;
  agentId?: string;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteShortTokens: number;   // Anthropic ephemeral_5m
  cacheWriteLongTokens: number;    // Anthropic ephemeral_1h
  reasoningTokens?: number;

  success: boolean;
  outcome: string;                 // canonical error category or "success"
  httpStatus?: number;
  providerRequestId?: string;
  providerResponseId?: string;
  stopReason?: string;
  serviceTier?: string;

  latencyMs: number;
  timeToFirstTokenMs?: number;
  streaming: boolean;
  toolCallCount: number;

  routing: {
    policy?: string;
    reason?: string;
    attemptIndex: number;
    fallbackFrom?: string;
    fallbackTrigger?: string;
    accountLabel?: string;
  };

  provenance: "provider_reported" | "local_estimate";
  costEstimateUsd?: number;        // advisory only; never authoritative
  extra: Record<string, unknown>;  // namespaced: extra.anthropic, extra.zai, extra.usage, ...
}
```

- FR-USAGE-001: `eventId` is stable for replay.
- FR-USAGE-002: Attempt events and logical summaries use distinct IDs.
- FR-USAGE-003: When the provider returns a request ID (Anthropic `request-id`, OpenAI `x-request-id`, Z.ai request ID), it becomes the attempt `eventId`. This is deliberate: Claude Code transcripts carry the same Anthropic request ID, so Tokemetry's keep-max upsert deduplicates proxy-reported and transcript-collector-reported events for the same request (D-002).
- FR-USAGE-004: Deterministic fallback ID (hash of logicalRequestId, attemptId, provider, model, timestampStarted) when no provider ID exists.
- FR-USAGE-005: Streaming snapshots reuse the event ID with increasing sequence; final events are marked (FR-USAGE-006).
- FR-USAGE-007: Negative token values rejected.
- FR-USAGE-008: Unknown token categories retained in `extra.usage`.
- FR-USAGE-009: Prompt, response, tool arguments, file paths, and code are excluded — enforced by allowlist serialization.
- FR-USAGE-010: The event builder is protocol-independent.
- FR-USAGE-011: Failure events retain known token usage.
- FR-USAGE-012: Client-cancelled requests emit events when an upstream attempt began.
- FR-USAGE-013: Time-to-first-token recorded for streams.
- FR-USAGE-014: All timestamps UTC.

### 11.15 Tokemetry Integration (real contract, D-002)

The target is the Tokemetry ingest API as specified in `C:\devel\tokemetry` (design spec dated 2026-07-09): `POST /api/v1/ingest/events`, batched, **all-or-nothing per batch**, idempotent via `event_id` keep-max upsert, bearer-token auth, cost computed server-side, sanity validation (non-negative counts, token-math bounds).

Mapping canonical attempt event -> Tokemetry `usage_events` row:

| Tokemetry field | Source |
|---|---|
| `event_id` | `eventId` (provider request ID preferred; FR-USAGE-003) |
| `provider` | `provider` |
| `machine_id` | configured machine name (`integrations.tokemetry.machine`) |
| `session_id` | `sessionId` |
| `ts` | `timestampStarted` |
| `model` | `nativeModel` |
| `project` | `project` (optional, configurable mode: raw / alias / hash / omit) |
| `entrypoint` | `"proxy"` |
| `input_tokens` .. `cache_write_long_tokens` | token fields 1:1 |
| `service_tier` | `serviceTier` |
| `cost_usd` | **not sent** (server computes); `costEstimateUsd` goes to `extra.aipp.cost_estimate_usd` |
| `provenance` | `"local_estimate"` (Tokemetry vocabulary; provider-reported API counters, same trust level as transcript-derived data) |
| `source` | `"aiproviderproxy"` |
| `extra` | `extra.aipp.{client_protocol, upstream_protocol, requested_model, routed_model, outcome, http_status, latency_ms, ttft_ms, streaming, tool_call_count, routing{...}, reasoning_tokens, proxy_version, schema_version}` |

Requirements:

- FR-TOK-001: Tokemetry export defaults to disabled until configured (endpoint + token + machine name).
- FR-TOK-002: Only terminal **attempt** events are exported. Logical-request summaries stay local (they would double-count usage).
- FR-TOK-003: The exporter uses a durable SQLite outbox at `~/.aiproviderproxy/tokemetry-outbox.sqlite3`; events commit to the outbox before upload eligibility (FR-TOK-004).
- FR-TOK-005: Export never blocks request execution or streaming.
- FR-TOK-006: Batching by max count (default 100), max bytes (default 256 KiB), max age (default 2000 ms).
- FR-TOK-007: Ambiguous transport failures replay (idempotency makes this safe).
- FR-TOK-008: 429/5xx retried with exponential backoff and jitter; 401 pauses export and raises a config error; 400/422 trigger poison isolation via recursive batch splitting; poison events land in a DLQ (FR-TOK-009..012).
- FR-TOK-013: DLQ records contain payload, failure category, attempts, last response — redacted.
- FR-TOK-014: Oldest-first drain; queue size/age limits configurable; exceeding limits preserves request execution and emits a high-severity local alert (FR-TOK-015..016).
- FR-TOK-017: Graceful shutdown attempts a bounded flush; startup recovers unacknowledged records (FR-TOK-018).
- FR-TOK-019: Exporter status via CLI and health endpoint: enabled state, endpoint host, queue depth, oldest event age, last success, last error, DLQ count.
- FR-TOK-020: Manual DLQ retry after correction.
- FR-TOK-021: Machine and project identifiers support raw, aliased, hashed, or omitted modes.
- FR-TOK-022: Payloads include proxy version and event schema version.
- FR-TOK-023: No prompt, response, file path, tool argument, or code content in payloads; enforced by prohibited-key snapshot tests and an audit mode that prints exact payloads before enabling (FR-TOK-024).
- FR-TOK-025: The exporter is developed against a mock ingest server implementing the contract (all-or-nothing, keep-max, sanity validation); an integration test against the real Tokemetry server is added once Tokemetry Phase 1 is deployed.
- FR-TOK-026: Coordination item (tracked open question OQ-001): Tokemetry's upsert merge policy for dimension columns when two sources (proxy, transcript collector) report the same `event_id` must be agreed with the Tokemetry project before GA.

### 11.16 Exporter and Proxy Operations

- FR-OPS-001: Health endpoint reports provider registry, protocol registry, and exporter health.
- FR-OPS-002: CLI commands: `aipp tokemetry status | flush | dlq list | dlq retry | test-connection`.
- FR-OPS-003: Status output never exposes secrets.
- FR-OPS-004: Exporter metrics: queue depth, queue age, upload rate, retry rate, DLQ count, batch size, ingest latency.
- FR-OPS-005: Exporter logs are rate-limited to prevent outage log storms.
- FR-OPS-006: `aipp service install` supports systemd and launchd (ported) plus Windows (Scheduled Task) — the primary machine is Windows.

### 11.17 Product Identity, Cleanup, and Migration (D-001, D-008)

- FR-IDENT-001: Package renamed `aiproviderproxy`, `"private": true`, no `publishConfig`; binaries `aipp` and `aiproviderproxy`.
- FR-IDENT-002: State directory `~/.aiproviderproxy`; env vars `AIPP_CONFIG_PATH`, `AIPP_HOME_OVERRIDE`, `AIPP_PORT`, `AIPP_NO_COLOR`; default listen `127.0.0.1:4100`.
- FR-IDENT-003: `aipp migrate-from-relayplane` performs a one-time import: config v4 -> new schema v1 (with backup), plus history/budget/session/agent/trace/mesh data files copied or converted. Idempotent; documented rollback (keep `~/.relayplane` untouched).
- FR-IDENT-004: ALL RelayPlane cloud code paths are deleted: telemetry upload (`api.relayplane.com/v1/telemetry*`), lifecycle pings, `telemetryPinger`, version-check pings (`/v1/check`), signup/star nudges, claim flow, device login/logout, swarm client, mesh remote sync, upgrade command. Zero non-provider, non-Tokemetry network calls remain — verified by an egress test that fails on any unexpected hostname.
- FR-IDENT-005: Dead code deleted: `server.ts` (+ `@relayplane/ledger|auth-gate|policy-engine|routing-engine|explainability|learning-engine` dependencies and type stubs), `streaming.ts`, `tenant-isolation.ts`, `kill-switch.ts`, `credential-pool.ts`, `cost-ledger.ts`, `recovery.ts`, `recovery-mesh.ts`, `recovery-mesh-server.ts`, `helpers/config-loader.ts`, plus their orphaned tests. `@relayplane/core` usage (task-type inference, local run ledger) is replaced by small local modules.
- FR-IDENT-006: Kept subsystems (D-005): dashboard, budget manager + tracker, alerts, anomaly detection, tool router, response cache, mesh/osmosis/episodic stores (local-only; remote sync removed), session/agent/trace/routing-log trackers. Each is ported to consume lifecycle events.
- FR-IDENT-007: Content logging (D-006): stays ON by default, but is prominently documented (README section, first-run notice), gets `aipp content-log on|off|status`, retention limits, and owner-only file permissions where the platform supports it.

### 11.18 Configuration (single schema, D-008)

Target shape (`~/.aiproviderproxy/config.json`, `config_version: 1` of the new product):

```json
{
  "config_version": 1,
  "server": { "port": 4100, "host": "127.0.0.1", "accessToken": null },
  "protocols": {
    "anthropicMessages": { "enabled": true },
    "openaiResponses": { "enabled": true },
    "openaiChatCompletions": { "enabled": true }
  },
  "providers": {
    "anthropic": { "enabled": true, "baseUrl": "https://api.anthropic.com", "credential": { "type": "env", "name": "ANTHROPIC_API_KEY" }, "accounts": [], "auth": { "useMaxForModels": [] } },
    "openai":    { "enabled": true, "baseUrl": "https://api.openai.com/v1", "credential": { "type": "env", "name": "OPENAI_API_KEY" } },
    "zai":       { "enabled": false, "baseUrl": "https://api.z.ai/api/paas/v4", "credential": { "type": "env", "name": "ZAI_API_KEY" }, "codingPlan": { "enabled": false } },
    "google":    { "enabled": false, "credential": { "type": "env", "name": "GEMINI_API_KEY" } },
    "ollama":    { "enabled": true, "baseUrl": "http://localhost:11434" }
  },
  "models": { "overrides": {} },
  "routing": { "mode": "passthrough", "complexity": {}, "cascade": { "enabled": false }, "crossProviderCascade": { "enabled": false }, "policy": { "enforce": false } },
  "budget": {}, "cache": { "enabled": true }, "alerts": {}, "anomaly": { "enabled": false },
  "contentLog": { "enabled": true, "retentionDays": 7, "maxEntries": 10000 },
  "mesh": { "enabled": false },
  "integrations": {
    "tokemetry": {
      "enabled": false,
      "baseUrl": "http://tokemetry.wg.internal:8000",
      "credential": { "type": "env", "name": "TOKEMETRY_API_TOKEN" },
      "machine": "devbox-01",
      "project": { "mode": "omit" },
      "queuePath": "~/.aiproviderproxy/tokemetry-outbox.sqlite3",
      "batchMaxEvents": 100, "batchMaxBytes": 262144, "flushIntervalMs": 2000,
      "requestTimeoutMs": 15000, "maxQueueEvents": 100000, "maxQueueBytes": 536870912
    }
  }
}
```

- FR-CONFIG-001: Exactly one schema module and one loader (replaces four legacy surfaces); validated with typed schemas (zod); startup fails with actionable errors on invalid combinations.
- FR-CONFIG-002: The relayplane importer backs up before writing and is idempotent (FR-IDENT-003).
- FR-CONFIG-003: Unknown keys are preserved with warnings, never silently discarded.
- FR-CONFIG-004: Secrets are referenced (env or credentials file), not embedded, by default.
- FR-CONFIG-005: Env overrides for non-secret settings.
- FR-CONFIG-006: `aipp config show` prints effective config with secrets redacted.
- FR-CONFIG-007: Feature flags per protocol and provider.
- FR-CONFIG-008: Atomic writes with backup (port legacy behavior).
- FR-CONFIG-009: The YAML policy file moves to `~/.aiproviderproxy/policy.yaml`, version-checked.

---

## 12. Non-Functional Requirements

### 12.1 Performance
- NFR-PERF-001: Non-streaming proxy overhead p95 <= 50 ms excluding upstream latency.
- NFR-PERF-002: Streaming TTFT overhead p95 <= 100 ms excluding upstream latency.
- NFR-PERF-003: Telemetry persistence performs no synchronous network I/O on the request path.
- NFR-PERF-004: Stream translation never buffers the complete response.
- NFR-PERF-005: Outbox insertion p95 <= 5 ms.
- NFR-PERF-006: Exporter sustains >= 1,000 events/s in synthetic tests.

### 12.2 Reliability
- NFR-REL-001: Tokemetry outage never interrupts model traffic.
- NFR-REL-002/003: No accepted final usage event is lost across clean restart or forced termination after outbox commit.
- NFR-REL-004: Duplicate delivery acceptable; duplicate accounting is not (idempotent `event_id`).
- NFR-REL-005: Queue recovery is automatic.
- NFR-REL-006: Retry behavior deterministic and configurable.
- NFR-REL-007: Graceful shutdown has a configurable maximum drain duration.

### 12.3 Security
- NFR-SEC-001: Secrets redacted from all outputs (central utility, tested).
- NFR-SEC-002: State files owner-only where the platform supports it (icacls best effort on Windows).
- NFR-SEC-003: Provider base URLs validated (https or explicit localhost; custom URLs require opt-in) to reduce SSRF risk (NFR-SEC-004).
- NFR-SEC-005: Header forwarding uses allowlists per provider.
- NFR-SEC-006: Management endpoints never publicly exposed by default (FR-AUTH-012).
- NFR-SEC-007: `npm audit`/trivy scans meet quality gates (no HIGH/CRITICAL).
- NFR-SEC-008: Threat model covers malicious upstream responses, oversized stream events, JSON depth attacks.
- NFR-SEC-009: Egress allowlist test: the test suite fails if any code path can contact a hostname outside configured providers + Tokemetry.

### 12.4 Privacy
- NFR-PRIV-001: Exported events are content-free (tested via prohibited-key snapshots).
- NFR-PRIV-002: Identity-bearing metadata (machine, project, account labels) is configurable (raw/alias/hash/omit).
- NFR-PRIV-003: Local content logging (on by default, D-006) is documented in README and first-run output, toggleable via CLI, retention-limited, and logically separate from export.
- NFR-PRIV-004: Audit mode displays exact Tokemetry payloads before export is enabled.

### 12.5 Maintainability
- NFR-MAIN-001: Provider adapters independently testable.
- NFR-MAIN-002: Protocol fixtures versioned.
- NFR-MAIN-003: No provider-specific model lists in route code.
- NFR-MAIN-004: TypeScript strict mode passes; ESLint zero warnings; Prettier enforced.
- NFR-MAIN-005: Public interfaces documented (TSDoc).
- NFR-MAIN-006: Config importer covered by unit tests with real legacy fixtures.
- NFR-MAIN-007: vitest coverage gates: 80% line / 70% branch.

---

## 13. Error Model

Canonical categories: `client_validation_error`, `client_auth_error`, `policy_rejected`, `capability_unsupported`, `provider_auth_error`, `provider_rate_limited`, `provider_overloaded`, `provider_validation_error`, `provider_timeout`, `provider_connection_error`, `provider_stream_error`, `client_cancelled`, `budget_exceeded`, `internal_error`.

- Errors retain provider status and request ID when safe.
- Client-facing error shape matches the client protocol (Anthropic error envelope vs OpenAI error envelope).
- Retry logic keys on canonical categories, never message matching alone.
- Telemetry excludes sensitive upstream error bodies; raw bodies retained locally only under explicit diagnostic settings with retention limits.

---

## 14. Implementation Epics

Ordering is optimized for a working gateway early and for Tokemetry usability mid-project. Each epic becomes one Task Master parent task; subtasks separate code, tests, documentation, and observability.

### AIPP-1: Baseline, fixtures, and parity harness
Conformance baseline document committed (done with this PRD). Capture a sanitized fixture corpus from real traffic (Anthropic messages incl. tools/thinking/caching; chat completions; Gemini; Ollama). Build the replay/parity harness skeleton that can drive both legacy and new stacks and diff responses, stream event sequences, and usage.
**Accept:** corpus committed under `test/fixtures/`; harness replays corpus against legacy proxy green; baseline doc merged. **Deps:** none.

### AIPP-2: Scaffold, identity, quality gates, config v1
New directory skeleton; package rename (`aiproviderproxy`, private, bins `aipp`/`aiproviderproxy`); ESLint + Prettier + strict TS + vitest coverage + trivy CI gates; single config schema/loader with zod validation, redaction utility, atomic writes; `aipp migrate-from-relayplane` importer; state dir `~/.aiproviderproxy`.
**Accept:** `aipp start --legacy` runs the old proxy from the renamed package; importer migrates a real v4 config fixture; `aipp config show` redacts; CI gates green. **Deps:** AIPP-1.

### AIPP-3: Canonical lifecycle and event sinks
`RequestContext`, `Attempt`, `CanonicalUsageEvent` builder (allowlist serialization), sink registry (history, traces, sessions, agents, routing-log, budget hooks), snapshot support, deterministic fallback IDs, UTC timing, TTFT capture.
**Accept:** unit tests for IDs/serialization/privacy; a stub protocol handler produces correct events end-to-end. **Deps:** AIPP-2.

### AIPP-4: Provider framework, model registry, first adapters
Adapter contract + registry; model/capability registry with alias migration; generic OpenAI-compatible adapter (all eight compatible providers, misroute bug impossible); Anthropic adapter (API key, OAT, passthrough, token pool port, request-id capture, 5m/1h cache split); OpenAI adapter (chat + responses upstream, x-request-id, reasoning/cached tokens); error classifier.
**Accept:** adapter unit tests with injected transports; registry conflict/override tests; usage extraction fixtures for both cache TTL splits. **Deps:** AIPP-3.

### AIPP-5: Tokemetry outbox and exporter
SQLite outbox (WAL, commit-before-export), batcher, retry/backoff, poison splitting, DLQ, health, mapper to ingest contract (event_id policy per FR-USAGE-003), mock ingest server (all-or-nothing, keep-max, sanity validation), CLI ops (`aipp tokemetry ...`), audit mode, prohibited-key snapshot tests, chaos tests (kill mid-export, outage, disk full).
**Accept:** all FR-TOK requirements demonstrated against the mock server; restart/kill tests lose nothing after commit. **Deps:** AIPP-3 (AIPP-4 for real events).

### AIPP-6: Anthropic Messages surface
Protocol adapter: parse/validate, Anthropic error envelope, SSE state-machine encoder with full event vocabulary; Anthropic-upstream verbatim fast path (parity with legacy); translation path to OpenAI-protocol upstreams (tools both directions, thinking mapping, cache directive handling); count_tokens passthrough; tool-router enforcement; client-disconnect cancellation.
**Accept:** fixture suite (text/tools/thinking/caching/errors/streaming/translation) green; parity harness matches legacy on the Anthropic corpus; Claude Code smoke test (real session) passes on both fast path and a GLM/OpenAI-routed model. **Deps:** AIPP-4.

### AIPP-7: OpenAI Responses surface
Full `/v1/responses` implementation per 11.3 with state-machine streaming encoder, function tools, reasoning controls, hosted-tool rejection, usage extraction, Codex config example and smoke test; translation to chat-protocol upstreams capability-gated.
**Accept:** Responses fixture suite green; Codex completes a representative workflow; events reach the outbox. **Deps:** AIPP-4.

### AIPP-8: Chat Completions on the new stack
Reimplement `/v1/chat/completions` with translation parity plus fixes (cache tokens, thinking diagnostics), `/v1/models`, `/v1/estimate`; Gemini and Ollama adapters ported; alias compatibility (`rp:` accepted, `aipp:` added).
**Accept:** parity harness matches legacy on the chat corpus except documented fixes; Gemini/Ollama fixtures green. **Deps:** AIPP-4.

### AIPP-9: Z.ai provider
Z.ai adapter over generic-compatible with GLM extensions (thinking, reasoning_effort, tool_stream), model registry entries (glm-5.2 and configured siblings), cross-protocol reasoning mapping, fixtures streamed/non-streamed, live smoke test.
**Accept:** GLM-5.2 works from Claude Code (via Messages translation) and from Chat Completions; usage incl. cached tokens captured; Coding Plan remains unimplemented and off. **Deps:** AIPP-6, AIPP-8 (translation paths).

### AIPP-10: Routing, fallback, and retry hardening
Port routing modes and complexity classifier; structured attempt records for cascade/downgrade/rotation; pre-stream retry with backoff; stream retry rules; capability-preserving fallback; policy engine live enforcement behind flag; routing-log schema v2 with attempt linkage.
**Accept:** every FR-ROUTE requirement has a test; fallback chains visible in Tokemetry `extra.aipp.routing`; no double-billing of attempts. **Deps:** AIPP-4, AIPP-5.

### AIPP-11: Ported subsystems
Dashboard (rebranded, served from new server, model endpoints view incl. exporter health), budget manager/tracker, alerts + anomaly, response cache, tool-router on all surfaces (from AIPP-6/7/8 integration points), mesh/osmosis local stores (remote sync deleted), session/agent/trace trackers wired as sinks; content-log CLI.
**Accept:** feature parity checks vs legacy for each subsystem; dashboard functional on the new gateway; content-log toggle works and is documented. **Deps:** AIPP-6, AIPP-7, AIPP-8.

### AIPP-12: Security and privacy hardening
Redaction rollout to all outputs; SSRF base-URL validation; header allowlists; access-token enforcement for non-loopback; owner-only file permissions; egress allowlist test; threat-model review; security test suite (header injection, oversized events, JSON depth, token-in-DLQ).
**Accept:** all NFR-SEC/PRIV requirements demonstrated; trivy and npm audit clean. **Deps:** AIPP-5..AIPP-11.

### AIPP-13: Parity validation, cutover, cleanup, release
Full parity run; performance measurement against NFR targets; delete legacy files (FR-IDENT-005) and `--legacy`; delete remaining RelayPlane cloud code (FR-IDENT-004 verified by egress test); documentation set (README rewrite, docs/integrations/*, migration + rollback guide); Tokemetry live integration test (if server deployed); tag v2.0.0.
**Accept:** all Section 17 release criteria met. **Deps:** all prior epics.

---

## 15. Development Sequence

1. AIPP-1 Baseline and fixtures
2. AIPP-2 Scaffold, identity, config
3. AIPP-3 Canonical lifecycle
4. AIPP-4 Provider framework and first adapters
5. AIPP-5 Tokemetry outbox and exporter (early, so every subsequent surface produces production-quality telemetry)
6. AIPP-6 Anthropic Messages
7. AIPP-7 OpenAI Responses
8. AIPP-8 Chat Completions
9. AIPP-9 Z.ai GLM
10. AIPP-10 Routing hardening
11. AIPP-11 Subsystem ports
12. AIPP-12 Security hardening
13. AIPP-13 Cutover and release

AIPP-6, AIPP-7, AIPP-8 are parallelizable after AIPP-4/5. AIPP-9 needs the translation paths.

---

## 16. Testing Strategy

- **Unit:** schema conversion, error classification, usage extraction (incl. cache TTL split), alias resolution, capability filtering, event ID generation, outbox state transitions, retry schedules, batch splitting, redaction, config import.
- **Protocol conformance:** versioned sanitized fixtures for Anthropic Messages (requests, responses, streaming incl. thinking/caching), OpenAI Responses (objects + streaming events), Chat Completions, Z.ai chat responses and stream chunks; tool calls, reasoning, incomplete responses, errors.
- **Integration:** mock provider servers; mock Tokemetry ingest server (contract-faithful); timeouts, resets, auth failures, rate limits, fallback recording, client cancellation.
- **Parity:** recorded corpus replayed through legacy and new stacks with diffing (AIPP-1 harness).
- **End-to-end:** Claude Code via `/v1/messages` (Anthropic fast path and GLM-routed), Codex via `/v1/responses`, OpenAI SDK via chat completions, GLM-5.2 via Z.ai; Tokemetry query API confirms ingested usage (when deployed).
- **Chaos:** kill after outbox commit, kill during export, multi-hour Tokemetry outage, duplicate replay, disk full, corrupt outbox record, interrupted stream after partial output, malformed SSE, clock skew, queue overflow.
- **Security:** redaction, header injection, SSRF, oversized bodies/events, JSON depth, unauthorized management access, unsafe permissions, secret-in-DLQ, egress allowlist.
- **Gates (every commit):** vitest 100% pass with coverage 80/70, ESLint zero warnings, Prettier clean, tsc strict clean, trivy no HIGH/CRITICAL.

---

## 17. Release Acceptance Criteria (v2.0.0)

- AC-001: Claude Code completes representative text and tool workflows via the gateway (Anthropic fast path).
- AC-002: Claude Code completes a representative workflow routed to a non-Anthropic model via translation.
- AC-003: Codex completes representative workflows via `/v1/responses`.
- AC-004: Chat Completions clients remain operational with parity or documented fixes.
- AC-005: GLM-5.2 works through the standard Z.ai API.
- AC-006: Every terminal upstream attempt produces an idempotent Tokemetry event (verified against mock; against live server if deployed).
- AC-007: Tokemetry outage does not break model requests; restart/kill tests show no post-commit loss.
- AC-008: No prohibited content in exported payloads; egress test proves no non-provider, non-Tokemetry network calls.
- AC-009: Attempt-level fallback data visible in event metadata.
- AC-010: `aipp migrate-from-relayplane` succeeds on the owner's real config; rollback documented.
- AC-011: Performance targets measured; regressions documented.
- AC-012: Security review has no unresolved critical/high findings; quality gates green.
- AC-013: Legacy code deleted; README and integration docs rewritten for aiproviderproxy.
- AC-014: Z.ai Coding Plan remains unimplemented and disabled.

---

## 18. Rollout Plan

- **Phase 0 (AIPP-1/2):** no behavior change; baseline, fixtures, rename scaffolding; legacy remains default.
- **Phase 1 (AIPP-3/4/5):** canonical events + outbox running in shadow mode alongside legacy proxy operation; Tokemetry export to mock/dev instance.
- **Phase 2 (AIPP-6/7/8):** new gateway serves protocols behind `aipp start --gateway` on the primary machine; Claude Code and Codex canaries.
- **Phase 3 (AIPP-9/10/11):** Z.ai enabled; routing hardening; subsystems ported; gateway becomes default, `--legacy` kept as fallback.
- **Phase 4 (AIPP-12/13):** hardening, parity sign-off, legacy deletion, v2.0.0 across the fleet.

---

## 19. Risks and Mitigations

- **R-001 Protocol drift:** versioned fixtures, conformance version reporting, provider release monitoring.
- **R-002 Streaming translation bugs:** state-machine encoders, fixtures, real-client e2e tests.
- **R-003 Double accounting:** only attempt events export; logical summaries local; idempotent event IDs.
- **R-004 Cross-source dedup mismatch (proxy vs transcript collector):** shared `event_id` = provider request ID; coordination item OQ-001 with Tokemetry on dimension-merge policy; `source` column distinguishes origins.
- **R-005 Queue growth in long outages:** configurable bounds, alerts, drain tools.
- **R-006 Privacy leakage:** allowlist serialization, prohibited-key tests, audit mode, egress test.
- **R-007 Provider terms (subscription proxying):** OAT passthrough preserved as-is (existing personal use); Z.ai Coding Plan blocked pending compliance decision.
- **R-008 Greenfield stall / regression risk (chosen approach B):** parity harness from day one; legacy stays runnable until sign-off; fixture corpus recorded before any new code; epics sized to produce runnable slices.
- **R-009 Pricing disagreement:** Tokemetry authoritative; proxy sends estimates only in `extra`.
- **R-010 GLM/Anthropic thinking semantics mismatch:** map only representable content, never fabricate signatures, document limits per provider (OQ-002).

---

## 20. Resolved Decisions (2026-07-12)

- D-001: Remove all RelayPlane cloud integration entirely.
- D-002: Tokemetry contract comes from the existing spec at `C:\devel\tokemetry`; exporter built against a contract-faithful mock; live integration when Tokemetry Phase 1 deploys.
- D-003: `/v1/messages` gets full cross-protocol translation (Anthropic clients to OpenAI-protocol upstreams), with verbatim passthrough retained as the Anthropic fast path.
- D-004: Private fork; no external compatibility obligations; no npm publication.
- D-005: Keep dashboard, budget, alerts/anomaly, tool router (extended to all surfaces), response cache, and mesh/osmosis stores (local-only). Delete listed dead code.
- D-006: Content logging stays on by default, prominently documented, CLI-toggleable, retention-limited.
- D-007: Loopback binding by default without token; non-loopback binding requires a configured access token.
- D-008: Full rename to `aiproviderproxy` / `aipp` / `~/.aiproviderproxy` with one-time migration from `~/.relayplane`.
- D-009: Greenfield gateway (approach B) with parity-validated cutover and legacy deletion.
- D-010: The conformance baseline audit is committed together with this PRD (Epic AIPP-1 shrinks accordingly).

### Remaining Open Questions

- OQ-001: Tokemetry-side upsert merge policy for dimension columns when proxy and transcript collector report the same `event_id` (coordinate before GA; tracked in AIPP-5).
- OQ-002: Exact fidelity contract for mapping GLM `reasoning_content` / OpenAI reasoning into Anthropic `thinking` blocks (resolve during AIPP-6 with fixtures; do not fabricate signatures).
- OQ-003: Whether `provenance` for proxy-observed events should get a dedicated value in Tokemetry's vocabulary instead of `local_estimate` (Tokemetry-side decision; `source` column already distinguishes).

Open questions do not block implementation start; each is tracked inside the owning epic.

---

## 21. Task Master Decomposition Guidance

1. One parent task per epic AIPP-1..AIPP-13, in dependency order.
2. Subtasks separate implementation, tests, documentation, and observability; documentation is per-subtask, never batched.
3. Protocol adapters and provider adapters are never combined in one task.
4. AIPP-5 (outbox/exporter) precedes all protocol surface epics in execution order.
5. Explicit acceptance-test subtasks exist for Claude Code and Codex smoke tests.
6. A security/privacy review subtask gates the release epic.
7. A compliance decision subtask exists for Z.ai Coding Plan; no implementation task until approved.
8. Migration and rollback documentation are release blockers.
9. Requirement IDs (FR-*/NFR-*/AC-*) are referenced in task details for traceability.
10. Tasks are created manually with full implementation details (no AI research pass); the PRD is the single source.

---

## 22. Reference Sources

Verify current versions before coding:

- This repository (`standalone-proxy.ts` is the behavioral reference until cutover) and `docs/architecture/protocol-conformance-baseline.md`.
- Tokemetry repository (`C:\devel\tokemetry`): design spec and Phase 1 ingest implementation.
- Anthropic Messages API: streaming, prompt caching (ephemeral 5m/1h), service tiers, errors, count_tokens.
- OpenAI Responses API: streaming event reference, reasoning, prompt caching, Codex custom providers (`wire_api = "responses"`).
- Z.ai: API introduction, Chat Completion API, GLM-5.2 guide, `thinking`/`reasoning_effort`/`tool_stream` parameters, pricing, Coding Plan terms.
- OpenTelemetry GenAI semantic conventions.
- LiteLLM `model_prices_and_context_window.json` (Tokemetry pricing source; useful for the local estimate table).

---

## 23. Definition of Done

A requirement is done only when: implementation merged; unit and integration tests pass; protocol fixtures included where applicable; user-facing documentation updated; telemetry and privacy behavior tested; configuration migration covered; acceptance criteria demonstrably met; requirement IDs referenced in commits or pull requests.
