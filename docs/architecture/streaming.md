# Streaming architecture

Task 17 (PRD deferral: incremental client-side streaming). Describes how a
`stream: true` request is served on each of the three client surfaces, and which
invariants the implementation is required to hold.

Before Task 17, translated streams were **buffered**: the gateway dispatched the
upstream non-streaming, reconstructed a complete result, synthesized the whole
SSE transcript, and returned it as one body. A streaming client therefore
received the entire stream at completion — correct bytes, no incrementality, and
no meaningful time-to-first-token. Streaming is now incremental end to end.

## The path a streamed byte takes

```
upstream bytes
  -> httpTransport            (exposes the body as an async iterable)
  -> SseFrameSplitter         (reassembles whole SSE blocks across chunk boundaries)
  -> adapter.parseStreamEvent (per-provider SSE framing -> {event, data})
  -> decode                   (wire shape -> typed upstream vocabulary)
  -> translate                (upstream vocabulary -> client vocabulary)
  -> client SSE encoder       (stateful, already existed)
  -> writeResponse            (res.write per chunk, backpressure-aware)
```

Every stage is incremental. A verbatim path skips decode/translate/encode
entirely and forwards the upstream's bytes unaltered.

Key modules:

| Module                                    | Role                                                           |
| ----------------------------------------- | -------------------------------------------------------------- |
| `gateway/sse.ts`                          | `SseFrameSplitter`, `sseFrames` — chunk stream to whole frames |
| `gateway/transport.ts`                    | streaming `httpTransport`                                      |
| `gateway/stream-pipeline.ts`              | composition + verbatim usage observation                       |
| `protocols/anthropic/stream-decoder.ts`   | Anthropic upstream SSE -> typed events                         |
| `protocols/openai-chat/stream-decoder.ts` | chat upstream SSE -> typed events                              |
| `protocols/*/stream-translate.ts`         | one translator per direction                                   |
| `protocols/*/stream-encoder.ts`           | client wire format (pre-existing, unchanged)                   |

## Per-surface behaviour

| Client surface   | Upstream         | Mode                                     |
| ---------------- | ---------------- | ---------------------------------------- |
| Messages         | Anthropic        | verbatim pass-through                    |
| Messages         | OpenAI chat      | incremental translation                  |
| Chat Completions | OpenAI chat      | verbatim pass-through                    |
| Chat Completions | Anthropic        | incremental translation                  |
| Chat Completions | Gemini, Ollama   | **buffered** (no incremental translator) |
| Responses        | OpenAI Responses | verbatim pass-through                    |
| Responses        | OpenAI chat      | incremental translation                  |

Gemini and Ollama chat upstreams are the only remaining buffered streaming
paths: their transcript is still synthesized from a completed body. They are
correct, just not incremental.

## Invariants

**Post-stream retry is forbidden.** Once a byte has been written to the client
the response is committed: no retry, no fallback, no status change. This is
structural rather than defensive — the transport only exposes a stream for a
`2xx` event-stream response, so every error status arrives fully buffered and is
classified and retried before any byte is emitted. An upstream that fails
_after_ streaming has begun cuts the stream short; the client keeps its `200`
and sees a truncated body.

**A client always sees a well-formed stream.** If an upstream ends without its
terminator, the translator's `end()` closes any open block or item and emits the
terminal event, so an SSE client never waits on a stream that will not finish.

**Ordering is enforced by the encoders.** The client-surface encoders are state
machines that throw on an illegal transition rather than emitting a malformed
transcript. Translators are written to satisfy them — for example a thinking
block is suppressed entirely on the Responses surface rather than opening an
output item that would then be empty.

**Bytes are verbatim where verbatim is claimed.** The usage observer on a
pass-through stream reframes the bytes only to read them; it yields the original
chunks, so the client receives exactly what the upstream sent.

## Usage and telemetry

A streaming request's token counts do not exist until the upstream's trailing
frames arrive, long after the response status was committed. The usage event is
therefore emitted when the stream **ends**, via the pipeline's `onComplete`
callback, not when the response is dispatched. The callback runs in a `finally`,
so a client that disconnects mid-stream still produces exactly one usage event
carrying whatever the upstream had reported by then.

Where the counts come from, per upstream protocol:

- **Anthropic** — input and cache counts on `message_start`, final output count
  on `message_delta`; merged.
- **Chat** — one trailing, choice-less chunk carrying `usage`.
- **Responses** — the `usage` block on the terminal event's response snapshot.

## Transport contract

`TransportResponse.stream` is present **only** when the caller passed
`TransportOptions.stream` _and_ the upstream answered `2xx` with a
`text/event-stream` content type. Anything else — every error status, every
non-event-stream body — is fully buffered into `TransportResponse.body`, which
is what keeps error classification and pre-stream retry unchanged. When `stream`
is set, `body` is empty and the stream may be consumed at most once.
