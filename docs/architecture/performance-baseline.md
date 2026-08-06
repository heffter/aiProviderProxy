# Performance baseline

Epic AIPP-13, subtask 13.1 (NFR-PERF-001..006). Numbers from the benchmark at
`test/perf/benchmark.test.ts`, which measures the gateway's own overhead and the
telemetry hot paths against a near-zero mock transport (so provider latency is
excluded). The benchmark is not part of the coverage gate; run it explicitly:

```bash
npx vitest run test/perf/benchmark.test.ts --config vitest.gates.config.ts
```

## Results

Measured on the primary Windows development machine (Node.js, in-memory SQLite,
2000-iteration samples after a 200-iteration warm-up).

| Metric                                | Target (NFR-PERF)  | Measured (p95)          | Result |
| ------------------------------------- | ------------------ | ----------------------- | ------ |
| Non-streaming gateway overhead        | p95 < 50 ms        | **0.03 ms**             | pass   |
| Outbox insert (commit-before-export)  | p95 < 5 ms         | **0.02 ms**             | pass   |
| Exporter drain throughput (synthetic) | >= 1000 events/sec | **~160,000 events/sec** | pass   |

Representative single run:

```
[perf] non-streaming overhead p50=0.016ms p95=0.026ms p99=0.070ms
[perf] outbox insert          p50=0.010ms p95=0.020ms p99=0.064ms
[perf] exporter throughput    160726 events/sec (5000 in 0.031s)
```

## Notes

- The gateway's per-request overhead (parse -> route -> translate -> emit) is
  three orders of magnitude under the 50 ms budget; provider round-trip time
  dominates real latency, as intended.
- Streaming TTFT overhead is bounded by the same parse/route path plus the
  per-frame decode/translate/encode cost. Since Task 17 no stream is buffered:
  a verbatim upstream is forwarded byte for byte as chunks arrive, and a
  translated upstream is decoded and re-encoded one frame at a time, so client
  TTFT tracks upstream TTFT rather than upstream completion. The gateway adds
  one SSE reframe plus one encode per event, far inside the 100 ms budget. A
  live TTFT measurement against a real upstream is part of the release
  acceptance run (AC).
- The two exceptions still reconstruct from a completed body, because they have
  no incremental translator: Gemini and Ollama chat upstreams. Their streaming
  clients see the whole transcript at completion.
- A streaming request's usage event is emitted when the stream ends, not when it
  is dispatched: the token counts arrive in the upstream's trailing frames. The
  event therefore lands after the response body has been fully written, which is
  the correct ordering for telemetry but means a streamed request's usage is not
  observable mid-flight.
- The outbox is a synchronous commit-before-export SQLite insert; its p95 is far
  under the 5 ms budget, so telemetry never gates the request path.

Re-run this benchmark and update the table if the request path or the outbox
schema changes materially.
