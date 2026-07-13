# Protocol Conformance Baseline

**Date of audit:** 2026-07-12
**Audited revision:** `main` at v1.9.38 (commit 1014382)
**Scope:** routes, protocol conformance, providers, routing, credentials, configuration, telemetry, persistence, privacy, dead code.
**Companion:** `aiProviderProxy_multi_protocol_gateway_prd.md` (PRD v2.0). This document records what the code actually does today; the PRD defines what it must become.

---

## 1. Which server is the product

| File | Lines | Wired to CLI | Role |
|---|---|---|---|
| `src/standalone-proxy.ts` | 7,698 | Yes (`src/cli.ts:40,1740` calls `startProxy()`) | The real product. All protocol, routing, and provider logic lives here. |
| `src/server.ts` | 1,630 | No | Parallel "Agent Ops Proxy" built on six optional `@relayplane/*` packages. Never instantiated by the CLI. Broken for Anthropic (posts untranslated OpenAI bodies to `https://api.anthropic.com/v1/chat/completions`, a non-existent endpoint; `server.ts:1252-1265`). No streaming support. |
| `src/recovery-mesh-server.ts` | 405 | No | Standalone mesh hub (port 19600). Not exported, not started anywhere. |
| `src/launcher.ts` | 45 | Via `ProcessManager` only | Stub with `/health` only; comment admits the real logic "can be wired in later" (`launcher.ts:25`). |
| `src/streaming.ts` | 331 | — | Dead code. Zero imports repo-wide. |

The live server is raw `node:http` (`standalone-proxy.ts:4069`). Effective default bind: `127.0.0.1:4100` (CLI default `cli.ts:1614`; the internal `4801` fallback at `standalone-proxy.ts:3621` is always overridden by the CLI).

## 2. Route inventory (live server)

Model-facing:

- `POST /v1/messages` (`standalone-proxy.ts:5182`) — Anthropic Messages, passthrough (Section 3).
- `POST /v1/messages/count_tokens` (`:6253`) — thin Anthropic passthrough.
- `POST /v1/chat/completions` (`:6303`) — OpenAI-compatible, multi-provider translation (Section 4).
- `POST /v1/estimate` (`:6217`) — pre-flight cost estimate, rate-limited 60/min per socket IP.
- `GET /v1/models` (`:6287`, loose `url.includes('/models')` match) — static pseudo-model list.
- `POST /v1/responses` — **does not exist**. No route, handler, or stub.

Operational: `/status`, `/health(z)`, `/v1/version-status` (fires a dashboard telemetry ping), `/control/*` (enable/disable/config/budget/session-budget/model/kill; loopback-restricted at `:4135-4141`), `/v1/telemetry/*`, `/api/agents*`, `/` + `/dashboard*`, `/v1/token-pool/status`, `/v1/ollama/status`, `/v1/policy-nudge`, `/v1/policy-auto`, `/v1/mesh/*`, `/v1/knowledge/stats`, `/v1/config`, `/v1/sessions*`, `/v1/traces*`, `/v1/memory/*`, `/api/runs*` (returns stored request/response content).

## 3. `POST /v1/messages` — Anthropic-only passthrough, high fidelity

Architecture: the raw client JSON body is forwarded verbatim to `https://api.anthropic.com/v1/messages` with only `model` mutated for routing (and `thinking`/beta flags stripped in specific downgrade cases). `forwardNativeAnthropicRequest` at `standalone-proxy.ts:1702-1718`; body spread at `:5778`.

- Header validation: auth presence only (`hasAnthropicAuth`, `:3031`; 401 at `:5186-5190`). No `anthropic-version` validation (defaults to `2023-06-01`, `:1545`).
- Content blocks, system prompts, tools, tool_use/tool_result, `cache_control`: preserved by construction (passthrough), not parsed or validated.
- Streaming: **verbatim byte relay** (`res.write(chunk)`, `:5960-5964`) — all Anthropic SSE event types reach the client unmodified. A side-channel SSE parse extracts usage only (`:5966-5993`).
- Thinking: passthrough, except the `thinking` key is stripped when routing lands on Haiku (`:5779-5784`, `:5707-5711`) and the `context-1m` beta flag is stripped when downgrading to Sonnet (`:5506-5516`).
- Tool authorization: deny-by-default `ToolRouter` enforced **only on this route** (`:5602-5659`) — can strip denied tools or 403.
- Cross-provider routing: **impossible** on this surface. The handler can only reroute among Anthropic models.

## 4. `POST /v1/chat/completions` — translation layer, partial fidelity

- Validation: JSON parse (400), `model` required, `messages` must be array (`:6317-6424`).
- OpenAI -> Anthropic: `buildAnthropicBody` (`:1799-1835`), `convertMessagesToAnthropic` (`:1739-1794`; `tool` role -> `tool_result`, `tool_calls` -> `tool_use`), `convertToolsToAnthropic` (`:1842-1855`; rebuilds objects — unknown tool fields dropped), `convertToolChoiceToAnthropic` (`:1860-1872`).
- **No `thinking` support** on this path; no `cache_control` injection anywhere.
- Anthropic -> OpenAI non-streaming: `convertAnthropicResponse` (`:2418-2470`) keeps only `text` and `tool_use` blocks — **`thinking`/`redacted_thinking` silently dropped**; usage remap **drops `cache_creation_input_tokens`/`cache_read_input_tokens`** (downstream read at `:7588-7589` therefore always sees 0).
- Anthropic -> OpenAI streaming: `convertAnthropicStreamEvent` (`:2484-2608`) handles `message_start`, `content_block_start` (tool_use only), `content_block_delta` (`text_delta`, `input_json_delta`), `message_delta`, `message_stop`. **Silently dropped:** `thinking_delta`, `signature_delta`, `redacted_thinking`, `ping`. Cache counters are emitted as non-standard fields on the first chunk (`:2509-2513`) and re-parsed server-side (`:7304-7309`).
- Gemini: bidirectional translation `forwardToGemini`/`convertGeminiStream*` (`:2117-2401`).
- OpenAI/xAI/OpenRouter/DeepSeek/Groq streaming: verbatim pipe (`pipeOpenAIStream`, `:2675-2694`).
- Ollama: own NDJSON->SSE module (`src/ollama.ts`, 744 lines).
- Non-streaming responses are always fully buffered before responding (`executeNonStreamingProviderRequest`, `:7079-7152`). Streaming is never buffered.
- Tool authorization: **not enforced** on this route.

## 5. Providers

`DEFAULT_ENDPOINTS` (`standalone-proxy.ts:221-270`); dispatch via two `switch (targetProvider)` blocks (`:7079-7152` non-streaming, `:7154-7360` streaming). No adapter classes; free-function pairs per provider. Ollama is the only separate module.

| Provider | Upstream protocol | Auth | Status |
|---|---|---|---|
| anthropic | Native Messages | env `ANTHROPIC_API_KEY`, header passthrough, OAT (`sk-ant-oat*` -> Bearer + `anthropic-beta: oauth-2025-04-20`, unsupported beta flags stripped `:1628-1643`), token pool | Live |
| openai | OpenAI chat | env / bearer passthrough (`:3069-3083`) | Live (the `default:` dispatch case) |
| google | Gemini native (`?key=`) | `GEMINI_API_KEY`/`GOOGLE_API_KEY` | Live |
| xai | OpenAI-compatible | `XAI_API_KEY` | Live |
| openrouter, deepseek, groq | OpenAI-compatible (shared `forwardToOpenAICompatible`) | per-provider env / passthrough | Live |
| ollama | Ollama `/api/chat` NDJSON | none | Live |
| mistral, together, fireworks, perplexity | — | env vars declared | **Stubs with a live bug:** no dispatch case; if ever selected they fall into `default:` and are sent to `api.openai.com` with the wrong key ("misroute bug"). |

`.env.example` documents `AZURE_OPENAI_API_KEY` and `GITHUB_API_KEY` — pure drift, nothing implements them.

## 6. Model resolution

Resolution order in `resolveExplicitModel()` (`:2751-2830`): `RELAYPLANE_ALIASES` (`:330-333`) -> `SMART_ALIASES` rebuilt at startup from available API keys (`buildSmartAliases`, `:354-399`) -> `MODEL_MAPPING` (~35 hardcoded friendly names, `:275-324`) -> prefix rules (`claude-*`->anthropic, `gpt-*`/`o1-*`/`o3-*`->openai, `gemini-*`->google, `grok-*`->xai, `deepseek-*`/`groq-*`->**openrouter**, inconsistent with the explicit `deepseek` aliases). Capability tiers for complexity routing: `PROVIDER_COMPLEXITY_TIERS` (`:576-607`). No capability registry; no separation of alias vs native ID beyond these tables.

## 7. Routing, retry, fallback

- Modes: `standard | cascade | auto | passthrough | complexity` (`:668-672`).
- Complexity classifier: keyword/regex/token-count heuristic, last-user-message scoped (`classifyComplexity`, `:1429-1481`).
- Budget downgrade: `downgrade.ts` wired live (`:3936`, `:3961`) with response headers. Two overlapping budget systems (`BudgetManager`, `BudgetTracker`), both live.
- Same-provider cascade escalation on refusal/uncertainty regexes (`:680-694`, `:3170`).
- Cross-provider cascade: `cross-provider-cascade.ts`, live behind config (`:5847-5850`, `:7494-7495`), trigger statuses default `[429, 529, 503]`. **Hops are console logs only** — not persisted in `routing-log.jsonl` as structured attempts.
- Token pool: Anthropic-only rotation on 429, 2x401 -> 1 h quarantine, RPM learned from headers (`token-pool.ts`; wired `:5812-5835`).
- Cooldown circuit breaking: ad-hoc `CooldownManager` inside `standalone-proxy.ts` (live). The formal `CircuitBreaker` class (`circuit-breaker.ts`) protects only a CLI health check.
- **No same-endpoint retry with backoff exists** (grep for backoff/maxRetries: nothing).
- `agent-policy.ts` (YAML policy): imported but `resolvePolicy()` is **never called on the live path** — used only by `relayplane policy replay` simulation (`cli.ts:2538-2546`).
- Dead: `recovery.ts` recovery-pattern engine (only consumed by unwired recovery-mesh), `kill-switch.ts`, `tenant-isolation.ts`, `credential-pool.ts`.

## 8. IDs and usage extraction

- Captured: Claude Code session ID header (`X-Claude-Code-Session-Id`, validated, `session-tracker.ts:104-127`); per-request `randomUUID()` trace ID returned as `X-Relay-Trace-Id`; local `req-<counter>` history IDs; Anthropic message `id` reused for translated chunk IDs.
- **Not captured anywhere:** provider request-ID response headers (Anthropic `request-id`, OpenAI `x-request-id`). Only `retry-after` and rate-limit headers are read.
- Usage extraction: `/v1/messages` non-streaming reads full usage incl. aggregate cache counters (`:6061-6069`); streaming side-channel reads `message_start`/`message_delta` usage (`:5975-5983`). **The `cache_creation.ephemeral_5m/1h` split is never extracted** (only aggregates). `/v1/chat/completions` Anthropic path loses cache counters entirely (Section 4).
- Cost: `estimateCost()` in `telemetry.ts` with a local pricing table; recorded to budget/session/agent trackers.

## 9. Credentials and secrets

- Three overlapping subsystems: `credentials.ts` (clean module, **imported by nothing** — four files reimplement it inline with schema drift `apiKey` vs `api_key`), `token-pool.ts` (live, Anthropic-only), `credential-pool.ts` (dead).
- **No redaction utility exists** (grep `redact`: zero hits). Raw keys sit in plaintext `config.json`/`credentials.json`.
- Client-to-proxy auth: **none** on model endpoints; only `/control/*` is loopback-restricted.

## 10. Configuration

Four independent schemas read the same `~/.relayplane/config.json`:

1. `config.ts` `ProxyConfig` — the only versioned one (`CONFIG_VERSION = 4`, `:224`), sequential v1->v4 migrations, atomic writes + backup, corrupt-file fallback.
2. `standalone-proxy.ts` local `RelayPlaneProxyConfigFile` (`:782-844`) — no version, no migration; the same file is read three different ways in one startup block (`:3657-3698`).
3. `helpers/config-loader.ts` — dead.
4. `agent-policy.ts` — separate `~/.relayplane/policy.yaml`, version 1, rejects others.

## 11. Telemetry and phone-home (all to be removed per PRD D-001)

- Per-request telemetry (`telemetry.ts`): default OFF; when on, JSONL + batched upload to `api.relayplane.com/v1/telemetry[/anonymous]`.
- Lifecycle pings (`lifecycle-telemetry.ts`): default **ON**, independent of the telemetry flag; `proxy.activated`/`proxy.session`/`proxy.dashboard_linked` to `api.relayplane.com`.
- Second ping path (`telemetryPinger.ts`): `relayplane.com/api/v1/ping` on startup and dashboard load, same flag, duplicated functionality.
- Version check (`cli.ts:102-139`, duplicated `standalone-proxy.ts:112-137`): fires on **every** start to `api.relayplane.com/v1/check`; **not** gated by telemetry/lifecycle flags (only `RELAYPLANE_NO_UPDATE_CHECK`/`--offline`).
- Signup nudge auto-initiates a device-auth flow (`claim-flow.ts:40` POST to `api.relayplane.com/v1/cli/device/start`) after 100 requests.
- Mesh sync (off by default) targets `https://osmosis-mesh-dev.fly.dev` (`config.ts:285,567`) — a dev URL.
- Swarm client (`swarm-client.ts`): paid-key-gated calls to `api.relayplane.com/v1/route`.
- No outbound payload contains prompt/response content (verified across all fetch sites).

## 12. Local persistence and privacy

`~/.relayplane/` files: `config.json(+bak/tmp)`, `credentials.json`, `telemetry.jsonl`, `lifecycle.json`, `history.jsonl`, `routing-log.jsonl(+bak)`, `agents.json`, `policy.yaml`, `sessions.db`, `osmosis.db`, `mesh.db`, `budget.db`, `alerts.db`, `traces/index.db` + JSONL trees, `cache/index.db` + `cache/responses/*.gz`, nudge flags, plus dead-code stores (`cost-ledger.json`, `tenants.json`, `kill-switches.json`).

Privacy findings:

- **`history.jsonl` stores full user message and full response text by default** — gate is `dashboard.showRequestContent !== false` (`isContentLoggingEnabled`, `standalone-proxy.ts:1237-1239`), i.e. on unless hand-edited off; undocumented; served back via `GET /api/runs[/:id]` including `fullResponse` (`:4556-4562`, `:4712-4723`). 7-day / 10k-entry retention.
- Response cache (default ON) writes full gzipped response bodies to `cache/responses/{hash}.gz` (`response-cache.ts:420-442`); applies whenever temperature is unset/0.
- `agents.json` stores an 80-char plaintext system-prompt preview (`agent-tracker.ts:158`).
- Traces are hash-only by design (`trace-writer.ts`); the `toolInputPreview` field exists in the type but is never populated; `replay()` is unimplemented.
- The first-run disclosure ("request content never leaves your network", `telemetry.ts:530-547`) is accurate for network egress but silent about on-disk plaintext content.

## 13. CLI surface (current)

`init, start, status, telemetry, lifecycle, stats, config [set-key], login, logout, upgrade, autostart, service (systemd/launchd only), mesh, cache, budget, alerts, enable/disable (openclaw), ensure-running, agents list, setup, policy (show|init|set-agent|auto|suggest|test|rename|reset)`. Flags: `--port --host -v --audit --offline`. Env: `ANTHROPIC/OPENAI/GEMINI/XAI/OPENROUTER_API_KEY`, `RELAYPLANE_API_URL`, `RELAYPLANE_HOME_OVERRIDE`, `RELAYPLANE_CONFIG_PATH`, `RELAYPLANE_NO_UPDATE_CHECK`.

## 14. Dead code register (delete per FR-IDENT-005)

`server.ts` (+ optional deps `@relayplane/ledger|auth-gate|policy-engine|routing-engine|explainability` and required-but-unused `@relayplane/learning-engine`, stubs in `types/internal-packages.d.ts`), `streaming.ts`, `tenant-isolation.ts`, `kill-switch.ts`, `credential-pool.ts`, `cost-ledger.ts` (incl. its inconsistent `RELAYPLANE_HOME_OVERRIDE` handling), `recovery.ts`, `recovery-mesh.ts`, `recovery-mesh-server.ts`, `helpers/config-loader.ts`, `credentials.ts` (module form), `mesh.ts` top-level + `relay-config.ts` mesh config (dynamic imports of never-declared `@relayplane/mesh-*` packages), unwired `handleStatusCommand` (`cli.ts:733`), `launcher.ts` stub. Orphaned tests follow their subjects.

## 15. Known defects to fix or avoid in the new stack

1. Misroute bug: mistral/together/fireworks/perplexity fall through to `api.openai.com` (Section 5).
2. Cache-token usage dropped on `/v1/chat/completions` Anthropic path (Section 4).
3. Thinking blocks silently dropped in both chat translation directions (Section 4).
4. Provider request IDs never captured (Section 8) — required for Tokemetry event identity.
5. Anthropic 5m/1h cache-write split never extracted (Section 8) — required by Tokemetry schema.
6. Cascade hops not persisted as structured attempts (Section 7).
7. Tool authorization enforced on only one of two live surfaces (Sections 3-4).
8. No redaction, no client auth, undocumented default-on content logging (Sections 9, 12).
9. Version check fires regardless of telemetry opt-out (Section 11).
10. Four config schemas, one file (Section 10).
