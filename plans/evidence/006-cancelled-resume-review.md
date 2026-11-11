# Plan 006 — APPROVE

## Verdict

**APPROVE.** This completes the five selected correctness fixes as isolated, uncommitted proposals. The accepted worktree now composes 002,003,004,009,005 and006; original/main is unchanged. [Incremental006 patch](../patches/006-cancelled-resume.patch).

Executor: Pi/Luna `openai-codex/gpt-5.6-luna`; one bounded review correction. Only `extensions/lib/provider-driver.ts` and `tests/provider-driver.test.ts` changed incrementally. No dependency, timeout-duration, provider/MCP API, accounting or transcript behavior was changed. No commit, merge, push, deployment or publication occurred.

## Invariant and evidence

`continueTurn` now installs `turn.phase` before rebinding/listening to a signal that may already be aborted. Immediate settlement returns before installing a timer. Validation errors, optional-signal behavior, exact empty cancellation rejection and partial-text cancellation outcomes remain unchanged.

Controlled fake modes emit init or actual live text without a terminal result that could accidentally complete the suspension. Initial promises have rejection handling before readiness waits; the empty-case readiness promise exists before work starts. Native ref'd guards bound the reproduction, and tracked drivers close in teardown.

Original RED on the prerequisite code failed both pre-aborted cases because their watchdogs won, not because imports or fake readiness failed. `.pi/logs/red.log` preserves this evidence. Final tests cover:

- Empty pre-aborted resume rejects with cancellation.
- Partial pre-aborted resume returns `aborted: true` and exact `live-1 ` text.
- Obsolete prior-phase abort does not cancel a newly rebound phase; the current signal does cancel it.
- After immediate cancellation, a fresh normal child survives beyond the old 100ms continuation deadline. A native 150ms observation verifies the same PID remains idle, followed by successful bound-conversation reuse with spawn count still 2.

The last witness was added during review: simply completing a fast new turn before the old deadline would not falsify a stray timer that kills it later.

## Verification actually run

Node 22.23.4 / npm 10.9.9, macOS, locked graph, minimal `env -i`, explicit Node22 PATH and task-local HOME/PI_CODING_AGENT_DIR. Installs used `npm ci --ignore-scripts`; no real agy inference.

| Check | Actual result |
|---|---|
| First combined prerequisite gate, before 006 edits | Executor 327/327; typecheck and package dry-run pass |
| Final named cancellation suite | Independent 3/3, exit 0 |
| Full driver file | Independent 19/19, exit 0 |
| Provider consumers | Independent 40/40, exit 0 |
| Diagnostic/MCP/parser baseline | Independent 51/51, exit 0 |
| All-fixes full suite | Executor and independent 330/330, exit 0 |
| Final typecheck/package dry-run | Executor and independent exit 0 |
| Scope, whitespace, staging | Pass; incremental scope exactly two files |

All positive runs had zero failed, skipped or cancelled tests. The 51-case baseline and 330-case gate also cover the existing code needed by design-only 007/008; those reports can cite this exact unchanged-source evidence instead of repeating completed gates.

Raw reviewer logs and exits: `.pi/reviewer/{named,driver,consumer,design-baseline,tests,typecheck,pack}.{log,exit}`. Machine-readable commands, final hashes and unchanged prerequisite checks: `plans/execution/006/independent-checks.json`. Native lifecycle metadata: `plans/execution/006/worker.json`.

## Provenance and retained work

The two immutable baseline snapshots match approved 005. All ten non-owned prerequisite files were independently compared against their accepted 002/004/005 worktrees. The incremental export was independently regenerated, matched the worker export, and passed check-only application against the previous accepted driver/test state. Hashes stayed unchanged through independent tests.

Patch SHA-256: `d4d6ac20d4527a0263354a8d5b282d6007aab656ae4fd377a9abe2a34fa82ba2`.

Worktree: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-006-yxx758z7/worktree`, detached HEAD `1bf9d29`, all proposals uncommitted. The worker ended COMPLETE with no pending process/question; no extra agent/worktree or reset/clean was used. Earlier proposals and failures remain retained.

The remaining selected007/008 design reports were subsequently completed and independently approved; their features remain unimplemented. See the current index for both reports and the explicit native-usage implementation blockers. SDK/Zod advisory exposure from001 remains unresolved; Linux/Windows/minimum-Node and live inference were not tested. No changes have been applied to the original checkout.
