# Cross-source dedup coordination (AIPP-5, subtask 5.7; OQ-001)

This document records the proxy-side design for cross-source deduplication with
the Tokemetry ingest service and the open coordination item **OQ-001**. It is
the aiproviderproxy side of a two-repo agreement; the Tokemetry repo
(`C:\devel\tokemetry`, design spec `docs/superpowers/specs/2026-07-09-tokemetry-design.md`)
owns the server-side merge implementation.

## The dedup design (D-002)

A single logical request can be reported to Tokemetry by **two independent
sources**:

1. **aiproviderproxy** — this exporter, reporting the attempt it proxied.
2. **The Claude Code transcript collector** — reporting the same request as seen
   in the local transcript.

Both sources set the ingest `event_id` to the **provider request id** (the
Anthropic `request-id` header, OpenAI `x-request-id`, Z.ai request id). Because
the two sources observe the _same_ upstream request, they compute the _same_
`event_id`. The ingest contract's **`event_id` keep-max upsert** then collapses
the two reports into one `usage_events` row instead of double-counting.

Proxy-side guarantees that make this work:

- `eventId` is the provider request id whenever the provider returns one
  (FR-USAGE-003); only when no provider id exists does the proxy fall back to a
  deterministic hash (FR-USAGE-004), which the transcript collector cannot match
  — so a fallback-id event is proxy-only and never double-counted.
- Snapshots of one attempt reuse the `event_id` with an increasing `sequence`;
  the final is flagged. The exporter's local `dedupeByEventId` collapses
  snapshots to the highest sequence before sending, and the server keep-max
  handles any that still arrive separately.
- `provenance = "local_estimate"` and `source = "aiproviderproxy"` let the
  server distinguish proxy-reported rows from transcript-derived rows at the same
  trust level.

## Keep-max semantics assumed by the proxy

For a given `event_id`, the server keeps the report with the **maximum
sequence**, and among equal sequences prefers `finality = "final"`. Token counts
and metadata come from the kept report. `cost_usd` is always computed
server-side; the proxy never sends it (it sends `extra.gateway.cost_estimate_usd`
as advisory only).

## OQ-001 — dimension-column merge policy (OPEN)

When both sources report the same `event_id` but populate **different dimension
columns**, how should the server merge them into one row?

Concrete cases:

- The proxy knows `provider`, `routed_model`, `native_model`, routing/fallback
  context, and cache-write split; the transcript collector may know a richer
  `project`/`session` or user-facing `requested_model`.
- One source may leave a column null that the other fills.

**Proposed policy (proxy-side recommendation, pending Tokemetry sign-off):**

1. **Keep-max still selects the primary row** (by sequence/finality) for token
   counts and the numeric usage columns — those must come from a single
   consistent source to avoid double counting.
2. **Coalesce non-conflicting dimension columns**: for a dimension column that is
   null on the primary row but non-null on the other report, fill it from the
   other report.
3. **On a genuine conflict** (both non-null and different), prefer the
   `source = "aiproviderproxy"` value for upstream/routing dimensions
   (`provider`, `routed_model`, `native_model`, `service_tier`) and the
   transcript value for user-facing dimensions (`project`, `session_id`,
   `requested_model`) — each source is authoritative for what it directly
   observes.
4. Record the non-primary source in a `sources` set/array so a row's provenance
   is auditable.

This keeps usage numbers single-sourced (no double counting) while enriching
dimensions from both observers.

## Status

- **Proxy side: implemented and documented.** The exporter already emits the
  `event_id`, `provenance`, `source`, and `extra.gateway` fields the policy needs.
- **Server side: OPEN.** The merge policy above must be confirmed and implemented
  in the Tokemetry repo. Track under OQ-001. Until confirmed, the proxy makes no
  assumption beyond keep-max selecting a single primary row; it never depends on
  server-side coalescing for correctness of its own reports.
