# SYNTHETIC corpus notice

The fixture cases currently committed under `test/fixtures/<provider>/<case>/`
are **synthetic** — hand-authored representative protocol shapes produced by
`tools/generate-synthetic-corpus.ts`, not recordings of real provider traffic.

They exist so the corpus linter, the replay/parity harness, and the CI gate have
realistic data to run against before real capture is possible. Every payload is
run through the real scrubber, so no raw content or secrets are present — but the
usage numbers, ids, and structures are invented, not observed.

## What is NOT yet real

- Token/usage numbers are illustrative, not measured.
- Error cases (`error-4xx`, `error-429`) are constructed, not reproduced from a
  real provider.
- Streaming event sequences are representative, not captured byte-for-byte.

## Replacing with real captures

Run the legacy proxy with `AIPP_RECORD_FIXTURES=test/fixtures` and drive the
representative traffic in `README.md`'s coverage matrix; the `recordExchange`
tap writes real, scrubbed cases that overwrite these synthetic ones. Regenerate
the synthetic set at any time with:

```
node --import tsx test/fixtures/tools/generate-synthetic-corpus.ts
```
