# Release acceptance checklist — v2.1.0

Epic AIPP-13, subtask 13.5 (PRD Section 17). Every acceptance criterion with the
evidence that demonstrates it. The full gate (`npm run gates`, which runs
`lint`, `typecheck`, and the coverage suite `test:gates`) is green;
`npm audit --omit=dev` and `trivy fs` report no HIGH/CRITICAL.

| AC     | Criterion                                                     | Status                                  | Evidence                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-001 | Claude Code text + tool workflows via the Anthropic fast path | met                                     | `test/gateway/corpus-acceptance.test.ts`, `test/gateway/server.test.ts` (verbatim Messages path)                                                                                                                                                                                           |
| AC-002 | Claude Code routed to a non-Anthropic model via translation   | met                                     | `test/gateway/glm-messages.test.ts`, `test/gateway/zai-acceptance.test.ts` (Messages → GLM)                                                                                                                                                                                                |
| AC-003 | Codex workflows via `/v1/responses`                           | met                                     | `test/gateway/codex-smoke.test.ts`, `test/gateway/responses.test.ts`                                                                                                                                                                                                                       |
| AC-004 | Chat Completions parity or documented fixes                   | met                                     | `test/gateway/chat-corpus-acceptance.test.ts` + the two approved 8.2 fixes in `docs/architecture/parity-signoff.md`                                                                                                                                                                        |
| AC-005 | GLM-5.2 via the standard Z.ai API                             | met                                     | `test/gateway/zai-acceptance.test.ts`, `docs/integrations/zai.md`                                                                                                                                                                                                                          |
| AC-006 | Idempotent Tokemetry event per terminal attempt               | met (offline); live overlap outstanding | `test/integrations/tokemetry/*` incl. `cross-source-overlap.test.ts` (provider request id reaches `event_id`; two sources collapse to one row). Live two-source run: `test/live/tokemetry-overlap.mjs --real-collector`, blocked on a server credential and a running collector (task #18) |
| AC-007 | Tokemetry outage never breaks requests; no post-commit loss   | met                                     | commit-before-export outbox `test/integrations/tokemetry/outbox.test.ts`; sinks are non-blocking                                                                                                                                                                                           |
| AC-008 | No prohibited content in exports; egress proven               | met                                     | content-free events (`test/lifecycle/*`), `test/security/egress-allowlist.test.ts` (+ rogue-fetch meta-test)                                                                                                                                                                               |
| AC-009 | Attempt-level fallback data in event metadata                 | met                                     | `test/gateway/multi-attempt.test.ts`, `test/gateway/route-traceability.test.ts` (routing block, one event per attempt)                                                                                                                                                                     |
| AC-010 | `aipp migrate-from-relayplane` succeeds; rollback documented  | met                                     | `test/config/migrate-relayplane.test.ts`, `docs/migration.md`                                                                                                                                                                                                                              |
| AC-011 | Performance targets measured; regressions documented          | met                                     | `docs/architecture/performance-baseline.md` (all NFR-PERF met with margin)                                                                                                                                                                                                                 |
| AC-012 | Security review: no unresolved critical/high; gates green     | met                                     | `docs/architecture/threat-model.md`; `npm audit --omit=dev` = 0, `trivy fs` = 0 HIGH/CRITICAL                                                                                                                                                                                              |
| AC-013 | Legacy deleted; README + integration docs rewritten           | met                                     | AIPP-13.2 deletion commits; `README.md`, `docs/integrations/*`                                                                                                                                                                                                                             |
| AC-014 | Z.ai Coding Plan unimplemented and disabled                   | met                                     | `src/config/loader.ts` gate + `test/config/loader.test.ts`; `docs/integrations/zai.md` decision record                                                                                                                                                                                     |

## Outstanding

- **AC-006 live two-source overlap** — task #18. The offline half is now in the
  gate; the live run needs a `TOKEMETRY_TOKEN` and a running transcript
  collector. See `docs/integrations/tokemetry.md`.
- **Content logging for streamed responses** — task #21. Streaming buffers
  nothing, so a streamed request records an empty response body in
  `history.jsonl`. Content logging is off by default.

## Since the v2.0.0 tag

`v2.0.0` is tagged **and pushed** at `1ba4a9e` (annotated tag object
`9bec9087`). These landed after it and are therefore _not_ in that release:

| Task | Commit               | Summary                                          |
| ---- | -------------------- | ------------------------------------------------ |
| 15   | `eafeb07`            | runtime composition root wired into `aipp start` |
| 16   | `a7c79b7`            | request/response content capture for history     |
| 20   | `114a56a`            | typecheck/lint gate fixes in the test suite      |
| 17   | `f147a85`, `9d3956a` | incremental client-side SSE streaming            |
| 18   | `54b792d`            | cross-source dedup overlap harness and tests     |

Because `v2.0.0` is already published, it must **not** be re-pointed (that would
rewrite a shared ref, and force-push is forbidden). Task 17 adds a user-visible
feature plus two bug fixes, so the next release is a **minor** bump:
`package.json` and `PRODUCT_VERSION` are now `2.1.0`, with a `2.1.0` section in
the changelog.

## Release actions (owner)

The code is release-ready and the gate is green. The steps below are
owner-initiated because they are outward-facing, irreversible, or touch other
machines.

1. **Merge to main.** `origin/main` has _not_ diverged — it is a strict ancestor
   of `prd/aipp-epic1-baseline`, so this is a clean 86-commit fast-forward with
   no conflicts to resolve:

   ```bash
   git checkout main && git merge --ff-only prd/aipp-epic1-baseline
   git push origin main
   ```

   (`main` is checked out in the primary worktree, so run this there.)

2. **Tag v2.1.0** once merged, then push the tag:

   ```bash
   git tag -a v2.1.0 -m "v2.1.0: incremental client-side streaming"
   git push origin v2.1.0
   ```

3. **Public npm publish — still contraindicated.** `package.json` keeps
   `private: true` (the tool is fleet-distributed, not public npm) and npm is
   unauthenticated here. Only publish if you deliberately want a public release,
   which means removing `private: true` and running `npm login` first.

4. **Service registration** at a _stable_ install path — not the ephemeral
   worktree `dist`. `aipp service template` prints the install command
   (`schtasks /Create /TN aiproviderproxy /XML ...` on Windows; systemd/launchd
   elsewhere).

5. **Other fleet machines**: `aipp migrate-from-relayplane`, then the service
   install, per machine. Keep `~/.relayplane` untouched as rollback. The primary
   Windows machine is already migrated.

6. **Monitor** exporter health (`aipp tokemetry status`) and the dashboard for
   one week; file follow-ups for anything found.
