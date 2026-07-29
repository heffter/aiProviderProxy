# Release acceptance checklist — v2.0.0

Epic AIPP-13, subtask 13.5 (PRD Section 17). Every acceptance criterion with the
evidence that demonstrates it. The full gate (`npm run gates`, which runs
`lint`, `typecheck`, and the coverage suite `test:gates`) is green;
`npm audit --omit=dev` and `trivy fs` report no HIGH/CRITICAL.

| AC     | Criterion                                                     | Status                    | Evidence                                                                                                               |
| ------ | ------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| AC-001 | Claude Code text + tool workflows via the Anthropic fast path | met                       | `test/gateway/corpus-acceptance.test.ts`, `test/gateway/server.test.ts` (verbatim Messages path)                       |
| AC-002 | Claude Code routed to a non-Anthropic model via translation   | met                       | `test/gateway/glm-messages.test.ts`, `test/gateway/zai-acceptance.test.ts` (Messages → GLM)                            |
| AC-003 | Codex workflows via `/v1/responses`                           | met                       | `test/gateway/codex-smoke.test.ts`, `test/gateway/responses.test.ts`                                                   |
| AC-004 | Chat Completions parity or documented fixes                   | met                       | `test/gateway/chat-corpus-acceptance.test.ts` + the two approved 8.2 fixes in `docs/architecture/parity-signoff.md`    |
| AC-005 | GLM-5.2 via the standard Z.ai API                             | met                       | `test/gateway/zai-acceptance.test.ts`, `docs/integrations/zai.md`                                                      |
| AC-006 | Idempotent Tokemetry event per terminal attempt               | met (mock); live deferred | `test/integrations/tokemetry/*`, dedup by `event_id`; live run tracked as follow-up task #14                           |
| AC-007 | Tokemetry outage never breaks requests; no post-commit loss   | met                       | commit-before-export outbox `test/integrations/tokemetry/outbox.test.ts`; sinks are non-blocking                       |
| AC-008 | No prohibited content in exports; egress proven               | met                       | content-free events (`test/lifecycle/*`), `test/security/egress-allowlist.test.ts` (+ rogue-fetch meta-test)           |
| AC-009 | Attempt-level fallback data in event metadata                 | met                       | `test/gateway/multi-attempt.test.ts`, `test/gateway/route-traceability.test.ts` (routing block, one event per attempt) |
| AC-010 | `aipp migrate-from-relayplane` succeeds; rollback documented  | met                       | `test/config/migrate-relayplane.test.ts`, `docs/migration.md`                                                          |
| AC-011 | Performance targets measured; regressions documented          | met                       | `docs/architecture/performance-baseline.md` (all NFR-PERF met with margin)                                             |
| AC-012 | Security review: no unresolved critical/high; gates green     | met                       | `docs/architecture/threat-model.md`; `npm audit --omit=dev` = 0, `trivy fs` = 0 HIGH/CRITICAL                          |
| AC-013 | Legacy deleted; README + integration docs rewritten           | met                       | AIPP-13.2 deletion commits; `README.md`, `docs/integrations/*`                                                         |
| AC-014 | Z.ai Coding Plan unimplemented and disabled                   | met                       | `src/config/loader.ts` gate + `test/config/loader.test.ts`; `docs/integrations/zai.md` decision record                 |

## Outstanding

- **AC-006 live form** — deferred to follow-up task #14 (needs a deployed
  Tokemetry server); mock evidence stands in.

## Release actions (owner)

The code is release-ready. The following steps are owner-initiated because they
are outward-facing or irreversible:

1. `git tag v2.0.0` and push the tag.
2. Publish the package (if publishing) after a clean `npm run build`.
3. Fleet rollout: on each machine, `aipp migrate-from-relayplane` then
   `aipp service template` + the printed install command. Keep the old
   `~/.relayplane` state directory untouched as rollback.
4. Monitor exporter health (`aipp tokemetry status`) and the dashboard on each
   machine for one week; file follow-up tasks for anything found.
