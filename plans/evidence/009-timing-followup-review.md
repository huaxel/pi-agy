# Plan 009 follow-up — APPROVE; plan 003 verification unblocked

## Verdict

**APPROVE 009. APPROVE the unchanged 003 catalog proposal together with 009's test-fixture prerequisite.** The advisor read every changed hunk, requested one bounded correction, independently repeated the acceptance checks on unchanged final hashes, and reproduced the old driver-test failure with a controlled delayed startup.

Original-checkout source remains unchanged. All proposals are uncommitted and isolated; nothing was merged, pushed or published. The earlier [blocked attempt](009-timing-verification-review.md), partial patch and worktrees remain preserved as history, not final acceptance evidence.

- [Approved 009 test-only patch](../patches/009-timing-tests.patch)
- [Unchanged 003 catalog patch](../patches/003-tool-catalog.patch)
- Metadata: `plans/execution/009-followup/worker.json`
- Machine-readable independent results: `plans/execution/009-followup/independent-checks.json`

## What changed and why

009 changes only `tests/execution.test.ts`, `tests/preflight.test.ts`, `tests/provider-driver.test.ts`, and new `tests/timing-helpers.ts`. No production deadline, cancellation, retry, process-kill, model, dependency, manifest or workflow behavior changed.

- Virtual clock phases now check the real preflight retry: first 10,000ms cap, remaining 1,999ms still pending, final 1ms timeout; no third retry. A separate delayed-close case proves no retry when teardown consumes the remaining budget. Actual timeout errors and child-kill boundaries are asserted.
- Timeout-persistence tests receive the conversation-bearing init before forcing expiry. They exercise real parsing, aborted-run persistence and corrupt-store guidance. An id-less init gets the exact generic timeout, without fabricated conversation guidance.
- The test fixture owns cancellation, aborts before fake child close, waits for tracked work, and restores only its own public CommonJS spawn mock. Cleanup expiry rejects visibly; its native watchdog is cleared on success/failure. A permanent never-settling control and a frozen-clock hanging-preflight control verify rejection, real captured-child closure, tracked settlement, empty child set, restored outer fence and zero native fallback calls.
- The driver abort/respawn test now waits for the actual `agy: session started (fake)` activity before cancelling. Its fake delays startup by 0.6 seconds; cancellation rejection, normal next response and exact two-spawn count remain. A native watchdog bounds failed readiness, and finally cleanup runs before fixture PATH restoration.

The source-backed distinction is between a driver requesting an OS process and the shell fake reaching its counter/init. With a delayed start, an old 200ms abort may kill the first process before that counter is written. Readiness establishes the intended test precondition; increasing an arbitrary delay would not. This does not establish a general host-load/shell cause for every historical timing failure.

## Independent final-source checks

Node **22.23.4**, npm **10.9.9**, macOS, locked installed graph. All test/dependency execution used minimal `env -i`, explicit Node22 PATH, task-local HOME and PI_CODING_AGENT_DIR. Raw independent logs and exit files are under `.pi/reviewer/` in the corresponding worktree.

| Check | Result | Log prefix |
|---|---|---|
| Focused deadline/readiness/cleanup sample, fixed five runs | 8/8 each, exit 0 | base `focused-{1..5}` |
| All three affected test files | 66/66, exit 0 | base `affected` |
| Base standard gate | 309/309, typecheck and packaging exit 0 | base `base-{tests,typecheck,pack}` |
| Combined catalog/provider/driver/execution consumers | 97/97, exit 0 | integration `catalog-consumers` |
| Exact003+009 standard gate, round 1 | 314/314, typecheck and packaging exit 0 | integration `gate-1-{tests,typecheck,pack}` |
| Same combined standard gate, round 2 | 314/314, typecheck and packaging exit 0 | integration `gate-2-{tests,typecheck,pack}` |
| Old timer negative control | expected exit 1, counter actual 1 versus expected 2 | base `old-timer-negative` |
| Scope/whitespace/staging | pass; only scoped files; staging empty | direct Git checks |
| Composition/provenance | all four timing files byte-equal; 003 diff byte-equal to supplied patch; hashes unchanged through checks | `independent-checks.json` |

All positive runs had zero failed, skipped or cancelled tests. Packaging is a dry-run, not publication. Negative-control exit 1 is the intended reproduction of the old test assumption, not a failure of the accepted source.

### Reproduction control

The ignored derived file `.pi/derived/tests/provider-driver-old-timer.test.ts` restores only the selected case's old `setTimeout(..., 200)` abort while retaining the controlled 0.6s fake startup delay. It imports the real driver and helpers. Both executor and reviewer ran only that case and observed `expected: 2`, `actual: 1`. The readiness-gated source passes the fixed focused samples and full gates. The derived copy is not in the patch or package.

### Final source identity

```text
bc9cc891d4cbc9f7ebd91cba04264f7953b8a2979360a465fbb9931900c86f1e  tests/execution.test.ts
c3d2341b82817c368c3f658900e134a2b00249575a55036a5d05053178604496  tests/preflight.test.ts
2601d79a51e0303484da08a99e1b47f5225ae6f97a8924e996d33307862f22ac  tests/provider-driver.test.ts
4897c9aaf7926f512fec9e575369e0f463356db7f6aa17755d5cf0a513be8098  tests/timing-helpers.ts
```

009 patch SHA-256: `98a0d48a971e19cb4c6528ff89530cbc7f92f6d34c9baffd91139982aa013f51`. Both patches pass `git apply --check` against the original checkout; that check did not apply them.

## Executor review and provenance

The user explicitly authorized a fresh isolated Pi/Luna worker after the interrupted prior attempt. Executor: `openai-codex/gpt-5.6-luna`; one corrective review round. The reviewer rejected a vacuous child-array assertion, insufficient delayed-start proof and stale report counts. Final controls now observe actual hanging preflight, the negative driver case, and parsed final counts. Early superseded logs are not substituted for final results.

An initial focused command before dependencies existed failed; the worker then installed with `npm ci --ignore-scripts`. No dependency lifecycle scripts were enabled. The fresh attempt used non-destructive, byte-verified copying to refresh its four integration test files; no reset/clean occurred. The older attempt's reset/clean deviation remains documented in its historical review.

The fresh executor ended COMPLETE with native stop, no pending process/question and no nested agent, commit, staging, merge, deployment or publication.

## Retained worktrees and follow-through

- Base009: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-009-followup-z2zktn_f/timing`
- Exact003+009 integration: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-009-followup-z2zktn_f/catalog-integration`

Plan 005's predecessor gate is now satisfied **using the accepted003+009 bundle**, not the old standalone003 tree. 005 still needs its normal drift/file-ownership check before execution. Plans 005–008 were not started by this follow-up. No approved proposal was applied to main.

Remaining risks: fixed samples are not proof of impossible flakiness; Linux, Windows, minimum-Node and live inference were not tested here; SDK/Zod advisory exposure from001 remains unresolved. No combined gate has yet included002 and004 alongside003+009.
