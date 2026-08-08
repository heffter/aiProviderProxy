# Protocol conformance fixture corpus

Recorded, sanitized captures used as the behavioral reference for the gateway
(epic AIPP-1; requirements PP-013, G-010, NFR-MAIN-002, FR-ANTH-017). The parity
harness (subtask 1.4) replays these fixtures and diffs the results.

## Two eras, on purpose

The corpus was specified as a **parity baseline**: captures of the legacy proxy
(`src/standalone-proxy.ts`), to prove the greenfield gateway matched the stack it
replaced. That framing is no longer available. The rewrite removed
`standalone-proxy.ts`, its private `@relayplane` dependencies are not present,
and v2.1.0 has shipped — there is no legacy stack left to diff against, and
recording the gateway and calling it the baseline would only prove the gateway
matches itself.

What is still worth freezing is the gateway's own client-facing behaviour, so
real captures are recorded as a **regression** corpus: a case answers "what does
this surface return for this request", and a diff against it catches a change in
translation, streaming, or error shaping.

Consequently the corpus holds two kinds of case:

| Kind | Named | Origin |
|---|---|---|
| **real** | `<model>-<feature>[-stream]` | recorded from the gateway via the tap below |
| **synthetic** | `<feature>[-stream]` | hand-authored, see [SYNTHETIC.md](SYNTHETIC.md) |

## Layout

```
test/fixtures/
  <dir>/<case>/
    request.json     scrubbed request  { method, url, headers, body }
    response.json    scrubbed unary response { status, headers, body }
    stream.jsonl     one scrubbed SSE event per line { event, data }
```

- A case is **unary** (`request.json` + `response.json`) or **streaming**
  (`request.json` + `stream.jsonl`). Route is carried by `request.url`;
  streaming is implied by the presence of `stream.jsonl`, which is why a
  streaming case name carries a `-stream` suffix — sharing a directory would
  make the case ambiguous.
- `<dir>` is `anthropic`, `openai-chat`, `openai-responses`, `gemini`, or
  `ollama`. The first two and the last two are inherited from the parity era,
  where a directory named the upstream *provider*. `openai-responses` came with
  the tap, which records by *client surface* — there is no Responses provider,
  but there is a Responses surface. Real cases record the upstream that served
  them in `meta`, not in the path.

## Tooling

| File | Purpose |
|---|---|
| `src/fixtures/scrubber.ts` | Removes prompt/response text and every credential family; preserves structure (block types, roles, model ids, tool schemas, event ordering, usage numbers). |
| `src/fixtures/recorder.ts` | Shapes a raw interaction into a scrubbed fixture. |
| `src/fixtures/corpus.ts` | Case-directory layout, the `recordCorpusCase` tap, and the linter. |
| `src/fixtures/gateway-tap.ts` | The live tap: records a client exchange, unary or streamed, from inside the running gateway. |
| `test/fixtures/tools/lint-corpus.ts` | CLI wrapper that lints the committed corpus and prints the coverage matrix. |

`test/fixtures/tools/` re-exports the `src/fixtures/` modules so existing import
paths keep working.

### Scrubbing guarantees (enforced by `lint-corpus`)

1. No secret pattern survives (`sk-ant-`, `sk-`, `Bearer`, `AIza`, `xai-`, `gsk_`, `AKIA`, ...).
2. Every content-position string is a deterministic placeholder `<scrubbed:len:sha8>` (or `<redacted:secret>`); no raw prompt/response text survives.
3. Only allowlisted headers are kept (`content-type`, `accept`, `accept-encoding`, `anthropic-version`, `anthropic-beta`, `user-agent`); auth headers are dropped.

Tool **schemas** are preserved deliberately — names, descriptions and parameter
shapes — because the harness needs them to replay a tool-use case. Bear that in
mind before recording traffic whose tool descriptions you would not commit.

## Recording

Recording is **opt-in and behavior-neutral** — nothing is written unless
`AIPP_RECORD_FIXTURES` points at a directory:

```
AIPP_RECORD_FIXTURES=test/fixtures aipp start
<drive representative traffic>
```

The tap (`src/fixtures/gateway-tap.ts`, wired in `Gateway.listen`) sits between
`handle()` and `writeResponse()`, the only point where both sides of the client
exchange are in hand. Capturing deeper in would record the *upstream* view,
which for a translated route is a different protocol from the one the client
spoke and cannot be replayed against the surface it came from.

Guarantees, both covered by `gateway-tap.test.ts`:

- With the variable unset, `tapExchange` returns the identical response object —
  no wrapping, no parsing, no allocation.
- With it set, every chunk reaches the client unchanged and in order. Each chunk
  is parsed for recording *before* it is yielded: yielding first looks cheaper,
  but a client that hangs up never resumes the generator, so the last chunk the
  gateway produced would be missing from precisely the truncated-stream case
  that exists to capture it. Recording is capped at `MAX_RECORDED_EVENTS` and
  performs no IO on the streaming path; a write failure is swallowed.

Drive traffic deliberately when recording. Anything that reaches the gateway
while the variable is set becomes a candidate fixture.

## Linting

```
# via a TypeScript-aware runtime
node --import tsx test/fixtures/tools/lint-corpus.ts

# or through the test suite (same validation, runs in CI)
npx vitest run test/fixtures/committed-corpus.test.ts
```

Exit code is non-zero if any case fails; an empty corpus passes with a warning.

## Coverage matrix

29 cases, all passing the linter: **14 real**, 15 synthetic.

| Directory | Cases | Real | Synthetic |
|---|---|---|---|
| `anthropic` | 17 | 9 | 8 |
| `openai-chat` | 7 | 3 | 4 |
| `openai-responses` | 2 | 2 | 0 |
| `gemini` | 2 | 0 | 2 |
| `ollama` | 1 | 0 | 1 |

### Real captures

| Directory | Case | Kind |
|---|---|---|
| anthropic | `glm-plain-text`, `glm-plain-text-stream` | unary + streaming |
| anthropic | `glm-system-blocks` | unary |
| anthropic | `glm-tools`, `glm-tools-stream` | unary + streaming, tool_use |
| anthropic | `gpt-4o-plain-text`, `gpt-4o-plain-text-stream` | unary + streaming |
| anthropic | `glm-error-400`, `no-such-model-xyz-error-400` | error |
| openai-chat | `gpt-4o-plain-text`, `gpt-4o-plain-text-stream` | unary + streaming |
| openai-chat | `gpt-4o-tools` | unary, tool_calls |
| openai-responses | `gpt-4o-plain-text`, `gpt-4o-plain-text-stream` | unary + streaming |

### Still synthetic only

These have no real capture yet, and the reason is environmental rather than
outstanding work:

| Case | Why not recorded |
|---|---|
| `gemini/*`, `ollama/*` | No Google credential and no local Ollama in this environment. |
| `anthropic/extended-thinking` | Requires an Anthropic upstream; the gateway holds no Anthropic credential of its own and serves that provider only by forwarding a client's. |
| `anthropic/prompt-caching-cache-control` | Same. |
| `anthropic/count-tokens` | `/v1/messages/count_tokens` returns 400 for a non-Anthropic model, so only the error path is reachable here (recorded as `glm-error-400`). |
| `error-429`, `error-5xx` | Not reproducible on demand against a live provider. |

Recording the Anthropic-upstream cases needs a run with `ANTHROPIC_API_KEY` set,
or a capture taken from a Claude Code session — with the tool-schema caveat above
in mind.
