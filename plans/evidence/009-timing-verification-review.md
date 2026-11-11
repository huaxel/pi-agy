# Plan 009 review — historical interrupted attempt

**Superseded by the user-authorized fresh follow-up:** [final approval and matching-tree evidence](009-timing-followup-review.md). The failed partial proposal and observations below remain preserved as history, not the accepted source.

## Verdict

**BLOCK.** Plan 003 remains blocked; plan 005 must not proceed on the assumption that its predecessor is approved. The latest test-only proposal improves deterministic timing coverage, but it does not pass the project gate and its cleanup guard remains unsound. No production deadlines, dependencies, original-checkout source, commits or merges were changed.

Executor: Pi / `openai-codex/gpt-5.6-luna`, two review revisions. Its final revision stopped after an edit with the actual provider error `{"detail":"Bad Request"}`. There is no final COMPLETE report for that source. Earlier COMPLETE reports and passing integration rounds describe older versions and are not current acceptance evidence. The reviewer did not start another Pi process after recovery.

[Unapproved partial patch](../patches/009-timing-tests-partial.patch). Metadata: `../execution/009/worker.json`.

## Scope and useful progress

Only these source files differ in the timing worktree:

- `tests/execution.test.ts`
- `tests/preflight.test.ts`
- `tests/timing-helpers.ts` (new)

The partial proposal uses public CommonJS `child_process.spawn` mocking, virtual Date/timeouts, actual parser/store/error paths, phase-specific retry observations, exact no-id guidance, and a native-watchdog failure control. Production code remains unchanged by 009.

Source inspection establishes that the old observed-id case assumed conversation-bearing init would arrive before a total 1000ms setup-plus-execution budget. A generic id-less init alone cannot establish that state. The old preflight assertion mixed its deadline contract with host/process teardown elapsed time. These are timing-dependent test preconditions; a specific physical host, shell, or scheduling cause for the historical failures has **not** been established.

## Findings requiring correction

### P1 — Final partial revision fails typecheck

`tests/execution.test.ts:1177` still calls `controller.abort()` after the refactor removed that controller in favor of the fixture-owned signal. Actual standalone typecheck exits 2:

```text
tests/execution.test.ts(1177,7): error TS2304: Cannot find name 'controller'.
```

The six selected tests passing does not exercise this failure-path reference or substitute for compilation. Finish the refactor without reintroducing competing cancellation ownership.

### P2 — Cleanup timeout silently succeeds and leaves its native timer alive

`tests/timing-helpers.ts:109–115` races tracked settlement against a **resolving** 5000ms native timeout, ignores which branch won, then restores spawn. A tracked operation may therefore remain pending while the fixture reports success. The native timeout is also never cleared when settlement wins, keeping otherwise-finished test processes alive until it fires.

The reviewer reproduced this without spawning any child or modifying source: track a never-settling promise, return `"body returned"` from the fixture callback, and await the fixture. After five seconds it returns that success value and restores the original spawn function while the tracked promise remains unsettled. Raw evidence: `.pi/reviewer/cleanup-control.log` / `.exit` in the timing worktree; exit 0 means the defect was reproduced, **not** that cleanup passed.

Cleanup expiry must fail visibly, timers must be cleared on every path, and cancellation/settlement/restoration ownership must remain safe when the operation does not cooperate. Do not fabricate the SUT error or allow a late native CLI fallback. The selected timing run reported ~58ms of executor-case work but ~5829ms total process duration, consistent with the retained five-second timer.

### Additional full-gate failure in an unchanged test

Independent final-tree `npm test` exits 1: **307/308 pass**, zero skipped/cancelled. The failure is:

```text
tests/provider-driver.test.ts:219
abort kills the child and the next turn respawns
Expected spawnCount() === 2; actual 1
```

The assertion is at line 231. This case aborts after a real 200ms timer; the file was not modified by 009. Its causal relationship to this proposal is **not established**. Do not call it fixed, substitute an isolated lucky retry, increase the timer, or edit this out-of-scope file as an incidental test-only change. Diagnose it separately before deciding whether the scope needs a new plan.

## Independent checks on the final partial timing tree

Node 22.23.4 / npm 10.9.9, macOS. Dependency/test execution used `env -i`, explicit Node22 PATH, and task-local HOME/PI_CODING_AGENT_DIR under ignored `.pi/reviewer/`. No live inference occurred.

| Check | Actual result | Evidence under timing worktree |
|---|---|---|
| Six selected deadline/readiness/watchdog cases | exit 0; 6/6, no skips/cancellations | `.pi/reviewer/final-focused.log` / `.exit` |
| Standalone typecheck | exit 2; undefined `controller` | `.pi/reviewer/final-typecheck.log` / `.exit` |
| Standard gate, starting with `npm test` | exit 1 at tests; 307/308; later chained checks not executed | `.pi/reviewer/final-tests.log` / `.exit` |
| Standalone package dry-run | exit 0; 42 entries | `.pi/reviewer/final-pack.log` / `.exit` |
| Cleanup negative control | defect reproduced; script exit 0 | `.pi/reviewer/cleanup-control.log` / `.exit` |
| Whitespace / scope | `git diff --check` exit 0; only the three test paths above | direct diff/status inspection |

The final three timing files are **not byte-equal** to the retained catalog-integration checkout. Consequently, no earlier combined-tree result proves this final partial revision. The required final-source five-repeat sample and two consecutive matching combined standard gates have **not** been completed. No final integrated gate was attempted by the reviewer against mismatched files.

Final timing-source SHA-256:

```text
e3ad2c2a6145f041f6cbed71ab1f4398402861906524a1da01cd6742cbbc84f8  tests/execution.test.ts
c3d2341b82817c368c3f658900e134a2b00249575a55036a5d05053178604496  tests/preflight.test.ts
56efe7b03b4c1f645bc2c8b7c1fe6879abaf2e3c6126743ecc8966641190825d  tests/timing-helpers.ts
```

## Provenance and execution deviations

- Initial spawn mocking targeted an unsuitable object and failed with `Cannot redefine property: spawn`. A private loader-hook workaround was rejected. The reviewer actually verified public CommonJS mocking on Node22 both with and without the repository resolution hook; the current proposal uses that public boundary.
- An early integration batch ran from the base cwd and produced wrong-tree results. Those results were discarded. Later executor integration passes belong to superseded source, not this final partial revision.
- The worker used `git reset --hard` and `git clean -fd tests/timing-helpers.ts` to refresh its own integration copy before the explicit correction. This was not separately authorized and must not be repeated. Only task-created, reconstructible proposal copies were affected; original/main and retained original patches were not reset. The final dispatch and plan now explicitly prohibit reset/clean and require non-destructive, byte-verified refreshes.
- Final native worker exit is a provider error, not successful completion or an identified quota/context cause. No replacement worker was launched during recovery. Earlier reports remain preserved in the worktrees as superseded evidence.

## Retained work and next bounded action

- Timing base: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-009-ltd59ai2/timing`.
- Superseded integration copy: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-009-ltd59ai2/catalog-integration`.
- Existing 002, 003 and 004 worktrees/patches are preserved. No source is applied to the original checkout. No worker question is pending; 009's worker exited without finishing its task.

A subsequent explicitly bounded executor should finish the stale cancellation reference and cleanup-failure guard, prove failure-path cleanup with a native fallback fence, investigate the unchanged driver case without masking it, and only then refresh exact003+009 integration non-destructively. Re-run the fixed acceptance samples on recorded final hashes. If a production fix or edits beyond 009's test scope are needed, stop for separate scope. No further automatic revision or dependent implementation is approved by this review.

Remaining independent risks: SDK/Zod advisory exposure from 001; Linux/minimum-Node/live inference not tested here; no combined verification of all approved 002/004 proposals with 003/009.
