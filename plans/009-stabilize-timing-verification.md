# Plan 009: Stabilize timing verification without changing production deadlines

> **Executor:** Follow this plan in an isolated Pi/Luna worktree. Diagnose before changing tests; preserve actual failure evidence. No commits, merges, publishing, delegation or original-checkout edits. The reviewer maintains `plans/README.md`.
>
> **Drift check:** `git diff --stat 1bf9d29..HEAD -- tests/preflight.test.ts tests/execution.test.ts tests/helpers.ts tests/timing-helpers.ts`. Inspect uncommitted changes too. Preserve existing proposals; do not overwrite another worker's worktree.

## Status

- **Priority:** P1 — verification prerequisite
- **Effort:** M
- **Risk:** MED — fake clocks/processes must still exercise real deadline logic
- **Depends on:** plan 001's approved locked baseline; plan 003's blocked final-gate evidence, not approval of its code
- **Category:** tests / dx
- **Planned at:** `1bf9d29`, 2026-11-11

## Execution review

**APPROVE after the user-authorized fresh follow-up.** Independent base gate309/309; exact003+009 gate314/314 twice consecutively; typecheck and packaging pass. Five fixed focused runs8/8, affected66/66, consumers97/97, real hanging-preflight cleanup and old-timer negative controls verified. [Final review](evidence/009-timing-followup-review.md); [approved test-only patch](patches/009-timing-tests.patch). No original-checkout source, production deadline, commit or merge changed. Plan003 is approved with this fixture prerequisite.

**Earlier attempt — BLOCKED after two review revisions.** The final Pi/Luna revision exited with `{"detail":"Bad Request"}` before completing its gate/report. Independent final partial-tree checks: 6/6 focused cases pass, full suite 307/308, typecheck fails at `tests/execution.test.ts:1177`, packaging passes. The helper also silently accepts unresolved tracked cleanup at its deadline. Final base/integration timing files do not match; old passes cannot approve them. [Read the final findings and exact evidence](evidence/009-timing-verification-review.md); [unapproved partial patch](patches/009-timing-tests-partial.patch).

The user subsequently explicitly authorized a **fresh isolated Pi/Luna worker** to finish this plan. Preserve the interrupted attempt and its findings as history, not acceptance. The fresh attempt has the narrowly reconciled scope below and at most two review rounds. Do not bypass 003 or change production behavior. No original-checkout source was changed or merged.

## Why this matters

Plan 003's functional catalog tests pass, but its full gate failed twice in existing timing-sensitive cases. Repeating until green is not a fix. Establish the cause and replace incidental wall-clock/launch assumptions with deterministic deadline and readiness assertions, retaining coverage of real production behavior.

## Current state and evidence

This is ESM TypeScript, strict `tsc --noEmit`, Node's test runner, and source-distributed Pi extensions. Scripts in `package.json`: `npm test`, `npm run typecheck`, `npm run pack:check`; no lint/build/just gate. Use `.js` relative imports in TypeScript and `node:assert/strict`/`node:test`. Available runtime: `/Users/juanbenjumea/.local/share/mise/installs/node/22.23.4/bin/node`; npm 10.9.9. Node 24.22.1 is also installed. Lockfile baseline uses MCP SDK 1.31.0 and Zod 4.6.5. No runtime dependency update is in scope.

Observed final plan003 failures (report: `plans/evidence/003-tool-catalog-review.md` in the original checkout):

1. `tests/preflight.test.ts:94–106` sleeps real subprocesses and asserts a 12,000ms budget rejects within <15,000ms. A reviewer run took about 15,059ms. Isolated baseline/fixed/shell comparisons sometimes passed. No shell/OS/load root cause has been established.
2. `tests/execution.test.ts:1082–1128` expects an observed conversation id after a 1,000ms total task budget. A reviewer run instead received only `agy timed out after 1000ms`.

The actual preflight contract (`extensions/lib/preflight.ts:80–99`) is:

```ts
const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
const attempt = (): Promise<void> => {
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && remaining <= 0) throw new Error("agy timed out before preflight retry");
  return Promise.all([
    checkAgyHealth(cwd, signal, remaining),
    checkAgyConnectivity(cwd, signal, remaining),
  ]).then(() => undefined);
};
```

`extensions/lib/execute.ts:97–108` starts its budget before config, directory-lock and preflight I/O:

```ts
const startedAt = Date.now();
const budgetController = new AbortController();
const budgetTimer = setTimeout(() => budgetController.abort(), Math.max(options.timeout_ms, 0));
```

Its catch at lines 316–343 can report an observed id only when the child actually emitted one. Fresh bounded persistence is intentional, even after the task signal aborts. Production must not invent an id when timeout occurs before init.

The current fake helper (`tests/helpers.ts`) uses real Bash/base64 subprocess startup. It first emits a generic init without a conversation id, then emits supplied output (possibly a second init with the id), then sleeps. A generic progress init therefore does **not** prove the conversation-bearing record has been consumed.

Current failure-case exemplar:

```ts
resetPreflightCache();
await assert.rejects(executeAgyTask({
  prompt: "hang with a corrupt store", mode: "plan", dir: process.cwd(),
  timeout_ms: 1_000, new_session: true, stream: true,
}, undefined), /conversation "observed-conv" was observed — resume with conversation_id/);
```

`extensions/lib/spawn.ts` resolves `node:child_process.spawn` dynamically through `createRequire`, so a scoped test mock can exercise real parser/timeout code with a fake child. The fake must not supply a real/fabricated PID that could be group-signalled. There are currently no `mock.timers` examples in this repo; inspect the installed Node test API/types rather than guessing its interface.

## Scope

**Permanent edits allowed:**
- `tests/preflight.test.ts`
- `tests/execution.test.ts`
- `tests/helpers.ts` only if genuinely needed; preserve defaults and all existing callers
- `tests/timing-helpers.ts` (test-only helper)
- `tests/provider-driver.test.ts` — only the abort/respawn test near original lines 219–232 and a minimal fixture startup-delay/readiness control if needed to establish its precondition; do not refactor other driver cases
- ignored `.pi/` logs/report in assigned worktrees

**Read only:** all production code and manifests; approved/blocked proposal artifacts supplied by reviewer.
**Out of scope:** production timeout/retry/kill/persistence semantics; adding exported production test seams; package/config/workflow changes; skipping tests, arbitrary larger timeouts, forcing global suite serialization, real inference, private auth/session data. Do not replace assertions with checks on test-authored expected text. Do not run `git reset --hard` or `git clean`, even in task-owned worktrees; refresh owned integration files with byte-verified copying or a non-destructive incremental patch.

The reviewer supplies a second isolated integration worktree. You may apply the exact plan003 proposal patch plus your test-only patch there for verification, but may not edit its catalog production code. This is not permission to merge into the original branch. Do not create additional worktrees.

## Commands you will need

Run dependency execution with `env -i`, task-local HOME/PI_CODING_AGENT_DIR under `.pi`, and an explicit Node22 PATH. Install only `npm ci --ignore-scripts` inside the assigned worktrees; no lifecycle scripts or global runtime installs.

| Purpose | Command | Expected |
|---|---|---|
| Focused timing/readiness cases | `node --import ./tests/resolve-hook.mjs --test --test-name-pattern="health retry|does not spawn a retry|persists the conversation when a run times out|reports an observed id when timeout persistence fails|does not claim a conversation|watchdog|cleanup|abort kills the child" tests/preflight.test.ts tests/execution.test.ts tests/provider-driver.test.ts` | All selected cases and new controls pass; record actual count |
| Whole affected files | `node --import ./tests/resolve-hook.mjs --test tests/preflight.test.ts tests/execution.test.ts tests/provider-driver.test.ts` | All pass |
| Standard gate | `npm test && npm run typecheck && npm run pack:check` | Exit 0; no skipped/cancelled tests |
| Scope | `git diff --check; git diff --name-only; git status --short` | Only scoped changes; no staged changes |

## Steps

### 1. Establish the failure mechanism, not a frequency story

Read the exact production paths, test helper and earlier logs. Capture Node/npm/shell versions and a minimal event timeline: budget creation, preflight completion, task spawn, generic init, conversation-bearing init, deadline, child close, save attempt. Do not log prompts, credentials or personal data. Use a bounded test fake/deliberately delayed startup to demonstrate that deadline-before-init must return no observed id; it is an invalid precondition for a test specifically targeting post-init persistence.

For the preflight case distinguish budget propagation from OS scheduling/process-tree teardown. State one hypothesis and a discriminating observation; do not assert CPU contention/shell version/sleep as proven because one retry passed. No unbounded stress workload or repeated full-suite fishing.

**Verify:** save `.pi/timing-diagnosis.md` with a source-backed timeline and a deterministic reproducer/control, or STOP if a production defect rather than a test-assumption defect is established.

### 2. Make deadline/retry assertions deterministic

Prefer scoped Node test mock timers (`Date` and `setTimeout`) and a minimal fake child-process boundary. Exercise the real `runPreflight` retry/deadline logic. Record probes; at a 12,000ms budget, advance the first 10,000ms timeout, allow promise continuations to schedule the retry, then prove the retry gets only the remaining 2,000ms. Advancing all 12,000ms in one jump can skip the retry and is insufficient coverage. Assert no third retry and no retry after an already exhausted budget.

Keep real-process integration/kill tests in place elsewhere; do not replace the entire CLI with a stub returning the expected answer. Fake children should expose realistic stdout/stderr/close/error/kill events, a missing PID, and deterministic close acknowledgement. Restore patched spawn/timers/cache in finally. A captured native watchdog can bound a broken test, but must not determine the SUT's correctness.

**Verify:** focused command passes; recorded virtual times/attempt counts prove remaining-budget semantics without the old <15,000ms host-speed assertion.

### 3. Gate timeout-persistence tests on actual conversation observation

Retain both successful timeout persistence and corrupt-store observed-only guidance assertions. Control budget expiry after the conversation-bearing init is processed, using scoped virtual timers/fake child events/readiness; do not merely extend 1000ms to a bigger number or wait for the fake helper's first generic init. Assert the run stays pending before the virtual boundary, then reaches the intended timeout branch and uses fresh persistence despite the aborted run signal. Add/retain a pre-init timeout control proving no observed-id claim is fabricated.

Use strict assertions on actual errors/store contents; final count/timeline must be driven by production code, not a test returning a fabricated error. Restore mocks before subsequent tests. Do not introduce native timer/subprocess leaks; real test-owned fallback resources must be bounded and cleaned.

**Verify:** focused command passes with expected post-init/pre-init branches; a negative control withholding the conversation id must fail the post-init guidance assertion (or pass the explicit no-id control). Capture actual output, not an assurance.

### 4. Finish the interrupted fixture refactor and investigate the abort/respawn precondition

Apply the archived unapproved `plans/patches/009-timing-tests-partial.patch` (SHA-256 `52aa5802eaf92e65aebb2ac561b7027e348a7048231dff3266efa594dc00abfb`) in the assigned fresh base worktree. This is the starting proposal, not an approved fix. Remove the stale undeclared `controller.abort()` reference in `tests/execution.test.ts:1177` without restoring competing cancellation ownership. In `tests/timing-helpers.ts`, abort the fixture signal first, force-close owned fake children, and bound tracked settlement with a **rejecting** native watchdog whose timer is cleared on success and failure. Restore only the fixture's own spawn mock in finally. A never-settling tracked promise must reject cleanup rather than return callback success. Add a failure control with a short test-only cleanup bound; do not wait five seconds in every focused test or leave referenced timers behind. Retain the frozen-clock/fallback-fence control and real parser/store assertions.

The newly failing unchanged driver case assumes that a shell fake has incremented its spawn-count file before aborting at 200ms. Source facts: its Bash script increments `spawns` before reading stdin and emitting `{"event":"init","init":{"model":"fake"}}`; `AgyProviderDriver.onLine` routes this init via `onActivity`; `formatStepProgress` produces exactly `agy: session started (fake)`. Thus observed init is a source-backed acknowledgement that the fake has started, whereas an arbitrary sleep is not.

First demonstrate the suspected precondition fault with a task-local bounded startup delay or equivalent controlled launch schedule: the old timer may abort before the script increments the count, despite the driver having requested a process. Distinguish this from a production recycling defect. If the hypothesis is supported, replace only this test's arbitrary 200ms abort with a bounded readiness wait on the actual driver's init activity, then abort and retain all cancellation/next-turn/counter assertions. Attach rejection handling before abort, and guarantee driver close and timer cleanup on failed readiness. A native watchdog bounds a broken test; it is not the SUT cancellation trigger. Keep a delayed-start control so the new test proves the ordering rather than being another lucky fast run. Do not raise 200ms to a bigger arbitrary delay, weaken `spawnCount() === 2`, or change production driver code. If evidence points to a production bug, STOP and report.

**Verify:** strict typecheck passes; cleanup control rejects visibly with no leaked watchdog; delayed-start driver control and exact abort/respawn case pass while preserving the observed cancellation and second spawn. Record actual control results.

### 5. Validate repeatedly within a fixed bound and recheck plan003 integration

Run selected deterministic cases five times (fixed count, record every result), affected files once, then the standard gate. Apply exact supplied plan003 patch plus your test-only patch in the assigned integration checkout. Run its five catalog/registration cases and the standard gate **twice consecutively**, recording every exit/count. No raising assertions/timeout limits or running until lucky. Stop if a meaningful failure remains after two reasonable fixes.

Keep source diffs separate: one test-only 009 patch and a combined integration checkout whose production/catalog changes exactly match the supplied 003 proposal. No 002/004 patch integration is required for this task.

**Verify:** both integration standard gates exit 0; typecheck/pack pass; source diff outside allowed test files is zero in the base worktree and byte-matches supplied 003 patch in the integration worktree. Save `.pi/executor-report.md` with diagnosis, commands, counts, controls, deviations and both worktree paths.

## Test plan

Use existing `node:test`/strict assertions and local test-only helpers. Cover remaining retry budget, no retry after exhaustion, maximum one retry, timeout before init, timeout after observed id with writable store, timeout after observed id with corrupt store, and teardown restoring timers/spawn/environment. Keep meaningful real-process tests outside these deterministic units. Five focused repeats plus two consecutive integrated full gates are fixed acceptance samples, not proof of impossible flakiness.

## Done criteria

- [ ] Source-backed diagnosis and deterministic controls distinguish test setup from production behavior.
- [ ] Production/manifests/lockfiles are unchanged by 009.
- [ ] No stale controller reference; cleanup deadline rejects and clears native timers; driver abort is readiness-gated only after its precondition fault is demonstrated.
- [ ] No deadline inflation, skipped assertions/tests, global test serialization, or fake fabricated error substitution.
- [ ] Focused five-repeat check, affected files, and base standard gate pass.
- [ ] Exact 003+009 integration passes catalog cases and two consecutive standard gates.
- [ ] Mocks/native watchdogs/owned child resources are cleaned and scope/whitespace checks pass.
- [ ] Report contains all actual failures/limits; reviewer owns the index and approval.

## STOP conditions

Stop and report if evidence points to a production bug, a needed production API/timeout change, unavailable/incompatible mock APIs after actually trying them, unsafe/global mock interference, or edits beyond scope. Stop after two reasonable failed fixes; preserve work, don't broaden scope or keep retrying silently. No commits, merges, publishing or deletion of retained worktrees.

## Maintenance notes

Deadline tests should verify ordering and remaining budget, not host scheduler speed. Integration timeout tests must prove the intended conversation state exists before forcing expiry. Scoped fake clocks must not leak into cache timestamps, lock heartbeats or later cases. Keep a small real-process layer for process-tree behavior, and promote new defects to separately scoped production plans rather than weakening test contracts.
