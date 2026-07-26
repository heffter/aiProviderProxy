# Using aiproviderproxy with Claude Code

The gateway exposes an Anthropic Messages surface at `POST /v1/messages` (plus
`POST /v1/messages/count_tokens` and `GET /health`). Point Claude Code at the
gateway by setting `ANTHROPIC_BASE_URL` to the gateway address; Claude Code then
sends all Messages traffic through it.

```bash
aipp start                       # listens on http://127.0.0.1:4100 by default
ANTHROPIC_BASE_URL=http://127.0.0.1:4100 claude
```

- **Anthropic models** (`claude-*`) take the fast path: the request and response
  are forwarded verbatim, so behavior is identical to talking to the Anthropic
  API directly.
- **Routed models** (e.g. an OpenAI or GLM/`glm-*` model, when configured) are
  translated to and from the Anthropic Messages shape.

## Automated acceptance (CI)

The epic acceptance suite runs in CI and requires no credentials:

- `test/gateway/corpus-acceptance.test.ts` drives the full non-streaming
  Anthropic fixture corpus (plain text, system blocks, tools + tool results,
  extended thinking, prompt caching, 4xx errors, count_tokens) through the
  gateway. For the fast path it asserts the client sees the upstream Messages
  body byte-for-byte — this is the parity check against the legacy proxy, which
  also forwarded verbatim.
- `test/protocols/anthropic/stream-encoder.test.ts` validates the streaming SSE
  encoder (message/content-block/message-delta ordering, tool JSON deltas,
  thinking, ping) against golden transcripts.
- `test/gateway/server.test.ts` covers the translated OpenAI path, error
  mapping, tool authorization, count_tokens, and client-disconnect cancellation.

## Manual smoke tests (real credentials required)

These require live provider credentials and Claude Code, so they are run by hand.
Record the date, gateway version, and outcome of each run below.

Prerequisites:

- A configured `~/.aiproviderproxy/config.json` with a working Anthropic
  credential (env or file reference), and — for the translated case — a working
  OpenAI (or GLM) credential.
- `aipp start` running in a separate terminal.

Checklist:

- [ ] **Health** — `curl -s http://127.0.0.1:4100/health` returns
      `{"status":"ok",...}`.
- [ ] **Anthropic fast path, plain chat** — with
      `ANTHROPIC_BASE_URL=http://127.0.0.1:4100`, start `claude`, send a simple
      prompt, and confirm a normal reply. Confirm a usage event was recorded.
- [ ] **Anthropic fast path, tool use** — run a prompt that triggers a built-in
      tool (e.g. a file read); confirm the tool call round-trips and the final
      answer is correct.
- [ ] **Anthropic fast path, streaming** — confirm tokens stream incrementally
      (not delivered all at once), and the turn ends cleanly.
- [ ] **count_tokens** — confirm Claude Code's token accounting works (it calls
      `POST /v1/messages/count_tokens`); the gateway returns the Anthropic count.
- [ ] **Translated routed model with tool use** — configure a routed model
      (OpenAI or GLM) and repeat a tool-use prompt; confirm the request is
      translated, the tool call works, and the response renders correctly.
- [ ] **Client disconnect** — cancel a long generation (Ctrl-C in Claude Code)
      and confirm the gateway aborts the upstream request and records a
      `client_cancelled` outcome (no orphaned upstream stream).
- [ ] **Tool authorization** (only if `tools.enabled` is set) — with a task-type
      header scoped to a pack, confirm out-of-pack tools are stripped, and a
      request for only-denied tools returns `403 permission_error`.

### Run log

| Date | Gateway version | Fast path | Translated | Notes |
| ---- | --------------- | --------- | ---------- | ----- |
| _(pending)_ | | | | Awaiting a run with live credentials |
