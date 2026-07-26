# Using aiproviderproxy with Codex

The gateway exposes an OpenAI **Responses** surface at `POST /v1/responses` (plus
`GET /health`). Codex talks to it as a custom provider with
`wire_api = "responses"`, so every Responses request Codex makes is routed
through the gateway to an interchangeable upstream.

```bash
aipp start   # listens on http://127.0.0.1:4100 by default
```

## config.toml

Codex reads `~/.codex/config.toml`. Add the gateway as a `model_providers` entry
and select it. The `base_url` must include the `/v1` suffix — Codex appends
`/responses` to it, giving `http://127.0.0.1:4100/v1/responses`.

```toml
# ~/.codex/config.toml

# Route Codex through the local gateway.
model         = "gpt-5-codex"
model_provider = "aipp"

[model_providers.aipp]
name     = "aiproviderproxy"
base_url = "http://127.0.0.1:4100/v1"
# Codex sends requests over the OpenAI Responses protocol.
wire_api = "responses"
# The gateway authenticates to the real upstream itself (see below), but Codex
# still wants a key to send. Point it at any env var the gateway accepts as a
# passthrough, or a placeholder when the gateway holds the real credential.
env_key  = "OPENAI_API_KEY"
```

### Credentials

The gateway resolves the upstream credential in this order:

1. A passthrough `Authorization` header sent by the client (Codex forwards the
   `env_key` value). Set `OPENAI_API_KEY` to your real OpenAI key to use this
   path.
2. The gateway's own `OPENAI_API_KEY` environment variable, when the client
   sends no usable key. In this mode `env_key` can be a placeholder.

Either way the key never needs to live in `config.toml`.

### Model selection

- `model` selects which model the gateway routes to. `gpt-5-codex` (and other
  `gpt-*`/`o*` ids) resolve to the OpenAI provider, which speaks the Responses
  protocol natively — the request and response are forwarded verbatim.
- A model that resolves to a chat-only upstream (for example a GLM or DeepSeek
  model, when configured) is served by translating the Responses request to
  Chat Completions and reconstructing a Responses object/stream. This is
  capability-gated: reasoning controls and parallel tool calls are only
  forwarded when the routed model supports them.

## Hosted tools

Provider-hosted tools (`web_search`, `file_search`, `code_interpreter`,
`computer_use`) are never emulated by the gateway. They pass through **only**
when the routed upstream is OpenAI itself and the tool is explicitly allowed:

```json
// ~/.aiproviderproxy/config.json
{
  "protocols": {
    "openaiResponses": { "enabled": true, "allowedHostedTools": ["web_search"] }
  }
}
```

Any hosted tool that is not allowed, or a request routed to a non-OpenAI
upstream, returns a structured `invalid_request_error` with a
`hosted_tool_unsupported` / `hosted_tool_not_allowed` code rather than a silent
or faked result.

## Unsupported in v1

- `previous_response_id` — the gateway stores no response state, so a prior
  response cannot be resumed. Resend the full conversation as `input` items.
  Codex does this by default.

## Automated acceptance (CI)

These run in CI and require no credentials (the OpenAI upstream is mocked):

- `test/gateway/codex-smoke.test.ts` boots the real gateway on a socket and
  drives a two-turn Codex tool-call workflow (function call, then
  function-call output to a final answer) through `POST /v1/responses`.
- `test/gateway/responses.test.ts` covers the native passthrough, the
  translated chat path (object + streaming), the hosted-tool policy, and
  tool-router enforcement.
- `test/protocols/openai-responses/stream-encoder.test.ts` validates the
  streaming SSE event ordering against golden transcripts.

## Manual smoke test (real Codex + real OpenAI key)

Run once before closing the epic. Record the outcome in the run log below.

Prerequisites:

- A working OpenAI credential (`OPENAI_API_KEY`).
- `~/.codex/config.toml` configured as above.
- `aipp start` running in a separate terminal.

Checklist:

- [ ] **Health** — `curl -s http://127.0.0.1:4100/health` returns
      `{"status":"ok",...}`.
- [ ] **Plain turn** — `codex exec "print hello world in python"` completes and
      prints a reply; confirm a usage event was recorded.
- [ ] **Tool-call workflow** — `codex exec "add a hello line to README.md"` in a
      scratch git repo: confirm Codex issues an `apply_patch` (or shell) tool
      call, the gateway round-trips it, and the edit is applied.
- [ ] **Streaming** — confirm output streams incrementally during a longer task
      and the turn ends cleanly.
- [ ] **Reasoning** — with a reasoning-capable model, confirm the turn succeeds
      and the recorded usage event carries a reasoning-token count (no reasoning
      text is ever exported).
- [ ] **Hosted tool rejection** — request a hosted tool that is not in
      `allowedHostedTools`; confirm an explicit capability error (never a faked
      result).
- [ ] **previous_response_id** — confirm a request carrying it returns a clear
      `unsupported_previous_response` error.

### Run log

| Date | Gateway version | Native (OpenAI) | Translated | Notes |
| ---- | --------------- | --------------- | ---------- | ----- |
| _(pending)_ | | | | Awaiting a run with a live OpenAI key + Codex |
