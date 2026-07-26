# aiproviderproxy

A local, multi-protocol AI gateway. It sits between your AI agents and the model
providers, speaking three client protocols at once and routing each request to
the right upstream — with observability, budgets, caching, and routing policy,
all running **locally, for free**. No cloud account, no telemetry phone-home, no
Docker: just Node.js.

The CLI is `aipp`.

## Features

- **Three client surfaces on one listener** — Anthropic Messages
  (`/v1/messages`), OpenAI Responses (`/v1/responses`, for Codex), and OpenAI
  Chat Completions (`/v1/chat/completions`). Point Claude Code, Codex, Cursor,
  or any OpenAI/Anthropic SDK client at the gateway.
- **Many providers** — Anthropic, OpenAI, Google (Gemini), Ollama, Z.ai (GLM),
  and OpenAI-compatible providers (xAI, OpenRouter, DeepSeek, Groq, Mistral,
  Together, Fireworks, Perplexity). Cross-protocol translation where needed.
- **Routing** — passthrough, complexity-based, cost/standard, and cascade modes;
  capability-preserving fallback; pre-stream retry with backoff; provider
  cooldowns; and an optional agent-routing policy.
- **Local operations** — a dashboard, unified budget enforcement, alerts and
  anomaly detection, an exact-match response cache, and a local-only mesh/memory
  store. Every subsystem is a non-blocking consumer of the request lifecycle.
- **Optional Tokemetry export** — content-free usage metadata to a single
  configured endpoint, with a durable commit-before-export outbox. Off by
  default. See [docs/integrations/tokemetry.md](docs/integrations/tokemetry.md).
- **Private by default** — binds to `127.0.0.1`; prompts and responses never
  leave your machine; no first-party phone-home (proven by an egress test).

## Quick start

```bash
npm install -g aiproviderproxy   # provides the `aipp` binary
aipp start                       # gateway listens on http://127.0.0.1:4100
```

Point a client at it:

```bash
# Claude Code (Anthropic Messages)
ANTHROPIC_BASE_URL=http://127.0.0.1:4100 claude

# An OpenAI-SDK client (Chat Completions)
OPENAI_BASE_URL=http://127.0.0.1:4100/v1 openai api chat.completions.create -m gpt-4o -g user "hi"
```

Provider credentials come from the environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `ZAI_API_KEY`, ...) or are passed through from the client.

## CLI

```
aipp start                     Start the gateway
aipp config show               Print the effective config (secrets redacted)
aipp content-log on|off|status Toggle local request-content logging (+ disclosure)
aipp tokemetry status|dlq      Exporter health / dead-lettered events
aipp policy replay             Simulate a routing policy over the routing log
aipp alerts recent|counts      Recent alerts or counts by type
aipp cache stats|clear         Response-cache stats / clear
aipp mesh status|on|off        Toggle the local mesh learning store
aipp service template          Print a run-at-boot service definition
aipp migrate-from-relayplane   Import an existing ~/.relayplane install
```

## Configuration

Config lives at `~/.aiproviderproxy/config.json` (override with `$AIPP_HOME` or
`$AIPP_CONFIG_PATH`). Every field has a default, so an empty file is valid. Key
sections:

```jsonc
{
  "server": { "port": 4100, "host": "127.0.0.1", "accessToken": null },
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434",
      "allowPrivateNetwork": true,
    },
  },
  "routing": { "mode": "standard", "cooldown": { "enabled": true } },
  "budget": { "enabled": false, "dailyUsd": 50, "onBreach": "downgrade" },
  "cache": { "enabled": true },
  "contentLog": { "enabled": true, "retentionDays": 7 },
  "integrations": { "tokemetry": { "enabled": false } },
}
```

`aipp config show` prints the resolved config with secrets redacted.

## Security model

- **Local by default.** Bound to loopback; binding to a non-loopback host
  requires `server.accessToken`, and management/dashboard/memory endpoints then
  require that token (compared in constant time).
- **SSRF-safe.** Provider base URLs must be https public hosts; private,
  loopback, or metadata addresses require an explicit `allowPrivateNetwork`
  opt-in per provider.
- **Header allowlists** in both directions; **redaction** on every diagnostic
  path; **owner-only** permissions on local state files; **request size and JSON
  depth limits** against DoS.
- **No egress** beyond the configured provider endpoints and the optional
  Tokemetry endpoint — enforced by a test.

See [docs/architecture/threat-model.md](docs/architecture/threat-model.md).

## Content logging (privacy)

When content logging is **on** (the default), full prompt and response content
is written to a local `history.jsonl` (owner-only, pruned to a retention
window). It never leaves your machine. Turn it off with `aipp content-log off`.
See [docs/content-logging.md](docs/content-logging.md).

## Run at boot

`aipp service template` prints a service definition for your platform (systemd,
launchd, or a Windows Scheduled Task) plus the exact install command. Installing
is a one-line manual step (it needs elevation).

## Documentation

- Integrations: [Claude Code](docs/integrations/claude-code.md),
  [Codex](docs/integrations/codex.md), [Z.ai / GLM](docs/integrations/zai.md),
  [Tokemetry](docs/integrations/tokemetry.md)
- [Migration from RelayPlane](docs/migration.md)
- Architecture: [threat model](docs/architecture/threat-model.md),
  [performance baseline](docs/architecture/performance-baseline.md),
  [parity sign-off](docs/architecture/parity-signoff.md),
  [Tokemetry dedup](docs/architecture/tokemetry-dedup.md)

## License

MIT.
