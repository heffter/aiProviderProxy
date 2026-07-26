# Parity sign-off

Epic AIPP-13, subtask 13.1. The new gateway is the default (`aipp start` boots
the new gateway; the bin entry points at the new CLI). This records the parity
result against the legacy proxy and the approved difference allowlist.

## Corpus parity

The acceptance corpus runs through the new gateway across all three client
surfaces and every provider, in the coverage gate (`npm run test:gates`):

- `test/gateway/corpus-acceptance.test.ts` — Anthropic Messages surface.
- `test/gateway/chat-corpus-acceptance.test.ts` — OpenAI Chat surface.
- `test/gateway/zai-acceptance.test.ts` — Z.ai / GLM.
- `test/gateway/codex-smoke.test.ts` — OpenAI Responses / Codex.
- `test/parity/**` — cross-surface fixtures.

All pass. The full gate is green (see the release acceptance checklist for the
exact counts at sign-off).

## Approved difference allowlist

Two intentional differences from the legacy proxy are approved (documented at the
point of change in `test/gateway/chat-corpus-acceptance.test.ts`, subtask 8.2):

1. **Cache-read tokens preserved.** The chat translation now carries
   `cache_read_input_tokens` into the usage event (the legacy path dropped it).
2. **Thinking diagnostics surfaced.** Anthropic thinking / redacted_thinking
   blocks produce an `x-aipp-thinking-diagnostics` header (counts only, never
   reasoning text) instead of being silently dropped.

Both are improvements; reasoning text is never exported (the invariant holds).

## Performance

All NFR-PERF targets are met with large margins — see
`docs/architecture/performance-baseline.md`.

## Sign-off

Parity is clean except for the approved allowlist above; performance targets are
met. The new gateway is signed off as the default product surface. Legacy
deletion (subtask 13.2) proceeds on this basis.
