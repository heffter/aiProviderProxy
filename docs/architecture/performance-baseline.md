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
- Streaming TTFT overhead is bounded by the same parse/route path plus SSE
  synthesis; because translated streams are buffered (dispatch non-streaming,
  synthesize the transcript), the added TTFT is the encoder cost over a
  reconstructed result, well within the 100 ms budget. A live TTFT measurement
  against a real upstream is part of the release acceptance run (AC).
- The outbox is a synchronous commit-before-export SQLite insert; its p95 is far
  under the 5 ms budget, so telemetry never gates the request path.

Re-run this benchmark and update the table if the request path or the outbox
schema changes materially.
