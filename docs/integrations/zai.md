# Using aiproviderproxy with Z.ai (GLM)

Z.ai's GLM models are a first-class provider. GLM is reachable from every client
surface the gateway exposes:

- **Chat Completions** (`/v1/chat/completions`) — Z.ai speaks Chat Completions
  natively, so GLM responses are forwarded verbatim (including
  `reasoning_content`).
- **Anthropic Messages** (`/v1/messages`) — Claude Code can drive GLM: the
  request is translated to Anthropic and GLM `reasoning_content` is surfaced as
  an (unsigned) thinking block.
- **OpenAI Responses** (`/v1/responses`) — a Responses `reasoning.effort` maps to
  GLM's reasoning controls (capability-gated).

## Models

| Alias / id | Native id | Reasoning | Context |
| ---------- | --------- | --------- | ------- |
| `glm`, `glm-5.2`, `zai/glm-5.2` | `glm-5.2` | yes | 200K |
| `glm-5-turbo` | `glm-5-turbo` | no (latency tier) | 128K |
| `glm-4.7` | `glm-4.7` | yes | 128K |

Any `glm-*` id or a `zai/<model>` prefix resolves to the Z.ai provider.

## Credentials

Set `ZAI_API_KEY` in the gateway's environment (bearer auth). A client
`Authorization` header, when present, is honored as a passthrough. The base URL
is `https://api.z.ai/api/paas/v4`; override it with
`providers.zai.baseUrl` if needed.

## GLM extensions

The GLM request extensions are forwarded verbatim and, on translated surfaces,
synthesized from the client's reasoning controls:

- `thinking` — `{ "type": "enabled" | "disabled" }`.
- `reasoning_effort` — `low` | `medium` | `high`.
- `tool_stream` — stream tool-call arguments (capability-gated).

Responses carry `reasoning_content` (the reasoning text) and GLM-specific usage
counters. Usage events capture cached prompt tokens (`cache_read`) and namespace
any GLM-specific numeric counters under `usage.extra["zai.*"]`. Reasoning text is
client-facing only; it is never exported to telemetry, and thinking-block
signatures are never fabricated.

## Configuration

Point Claude Code at the gateway and request a GLM model:

```bash
aipp start
ANTHROPIC_BASE_URL=http://127.0.0.1:4100 claude --model glm-5.2
```

Or from an OpenAI-SDK client:

```bash
OPENAI_BASE_URL=http://127.0.0.1:4100/v1 \
  openai api chat.completions.create -m glm-5.2 -g user "hi"
```

## Automated acceptance (CI)

`test/gateway/zai-acceptance.test.ts` exercises glm-5.2 from Chat Completions
(text, tools, reasoning, streamed — verbatim) and Messages (text, tools —
translated) against synthetic GLM upstream responses. `test/providers/zai/`
covers the adapter, GLM extensions, and the cross-protocol reasoning mapping.

## Manual live smoke test (real ZAI_API_KEY)

Run once before closing the epic; record the outcome below.

- [ ] **Chat Completions** — `curl` `/v1/chat/completions` with `model: glm-5.2`;
      confirm a normal reply and that a usage event was recorded.
- [ ] **Reasoning** — send a `thinking`/`reasoning_effort` request; confirm
      `reasoning_content` is returned (Chat) or a thinking block appears
      (Messages), and the usage event carries a reasoning-token count.
- [ ] **Claude Code (Messages translation)** — `claude --model glm-5.2`; run a
      prompt with a tool call; confirm the tool round-trips.
- [ ] **Cached tokens** — repeat a large prompt; confirm `cache_read` tokens
      appear in the usage event.

### Run log

| Date | Gateway version | Chat | Messages | Notes |
| ---- | --------------- | ---- | -------- | ----- |
| _(pending)_ | | | | Awaiting a run with a live ZAI_API_KEY |

## Coding Plan compliance (decision record)

**Decision:** aiproviderproxy does **not** proxy Z.ai *Coding Plan* subscription
traffic. Only the standard Z.ai API (a `ZAI_API_KEY`, billed per token) is
supported. The two are never conflated.

**Why:** the Z.ai Coding Plan is a seat-based subscription intended for use
through Z.ai's own coding tools; routing it through a third-party gateway is
outside its intended use, and the gateway must not implement or encourage it.

**How it is enforced:** the config flag `providers.zai.codingPlan.enabled`
exists so the intent is explicit, but it has **no implementation behind it** and
defaults to `false`. Startup validation (`loadConfig`) rejects a config that sets
it to `true` with a clear error directing the operator to a standard API key.
There is no code path that sends Coding Plan credentials upstream.

- Date of decision: 2026-07-26.
- Source: Z.ai Coding Plan terms of use (verify against the current published
  terms before revisiting this decision).

If this decision is ever revisited, it must be re-verified against the
then-current Z.ai terms and recorded here with a new date and source; enabling
the flag also requires an implementation task that keeps standard-API and
Coding-Plan configuration strictly separate.
