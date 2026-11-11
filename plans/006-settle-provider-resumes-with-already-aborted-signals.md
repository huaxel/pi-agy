# Plan 006: Settle provider resumes with already-aborted signals

> **Executor instructions:** Read this entire plan, follow the steps in order, and run each verification. Do not improvise around STOP conditions. Update only your status row in `plans/README.md` when complete, unless the reviewer owns the index.
>
> **Drift check (first):** `git diff --stat 1bf9d29..HEAD -- extensions/lib/provider-driver.ts tests/provider-driver.test.ts`. Also run `git status --short` and inspect uncommitted changes. Compare the excerpts below with live code. Any material mismatch requires an updated plan before editing; preserve other workers' changes.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW
- **Depends on:** plans/001-establish-the-locked-dependency-verification-baseline.md for verified baseline; plans/005-preserve-authoritative-terminal-provider-responses.md for serialized driver-file ownership
- **Category:** bug
- **Planned at:** commit `1bf9d29`, 2026-11-11
- **Execution review:** APPROVE; all-fixes stack330/330 independently, typecheck and packaging pass. [Final evidence and incremental patch](evidence/006-cancelled-resume-review.md). Original/main unchanged.

## Accepted prerequisites and execution baseline

Plans001–005 and009 are approved in retained worktrees; original/main remains untouched. The fresh006 executor must apply the exact archived patches in order: `002-process-tree.patch`, `003-tool-catalog.patch`, `004-bridge-sessions.patch`, `009-timing-tests.patch`, `005-terminal-response.patch` from `plans/patches/`. This combined prerequisite composition has not yet had a full gate, so verify it before editing006. Do not treat earlier separate approvals as combined-tree proof. If that baseline fails, preserve evidence and STOP rather than modifying other plans' files.

Snapshot the two006-owned files under ignored `.pi/baseline/`, hash every changed prerequisite file, and export006 as an incremental patch against that snapshot. Preserve005's512,000-character terminal cap and canonical response tests,009's readiness/clock controls, and002/004 lifecycle fixes. No commits/staging, hard reset/clean, extra worktrees, source edits in prior checkouts or index edits; the reviewer maintains the index. The continuation target below still matches approved005; known edits elsewhere in the file only shift test locations.

The concurrency property to verify is a **waiter-before-settlement ordering invariant**: the phase's resolve/reject handlers exist before any synchronous abort handler may run. A falsifying trace is a pre-aborted resume still pending at its bounded guard, or a timer armed after immediate settlement. Use real observable readiness/park transitions and an explicit timer/listener or subsequent-turn witness where practical; do not manufacture a matching terminal result.

## Repository and execution conventions

This is `@juanbenjumea/pi-agy` 0.7.9: an ESM TypeScript Pi extension distributed as source through npm. Delegation tools launch the Antigravity CLI; provider turns use a persistent process and a localhost MCP bridge. There is no compiler-output build, lint script, or `just ci` gate. Use explicit `.js` relative imports in TypeScript, strict types, `node:test`, and `node:assert/strict`. Tests resolve sibling TypeScript through `tests/resolve-hook.mjs`; invoke the exact commands below, not a guessed test-runner filter.

The audited environment used Node 24.22.1. CI uses Node 22, while the manifest claims >=20.3.0; do not change runtime support in this task. Initial gates passed with installed dependencies: 305 tests, typecheck, package dry-run. Those installed versions differed from the lockfile, so do not describe them as clean-install proof.

Work on an operator-provided branch/worktree or an isolated branch named `advisor/006-settle-provider-resumes-with-already-aborted-signals`. **Do not commit, push, publish, deploy, open issues/PRs, or merge without separate explicit authorization.** If authorized to commit, match Conventional Commit history (for example `23a0bf2 refactor: simplify agy extension guidance and modules`).

## Why this matters

An already-aborted resume signal can settle the active turn before its new phase promise exists. The function then installs a waiter on a turn marked settled; its timeout becomes a no-op and that waiter never resolves/rejects. A bounded fake-child probe reproduced a resume still pending after its own deadline.

## Current state

- `extensions/lib/provider-driver.ts:265–287`:
  ```ts
  if (options?.signal) {
    turn.signal = options.signal;
    const onAbort = (): void => {
      if (turn.settled) return;
      this.killChild();
      if (turn.text) this.settleDone(turn, { aborted: true });
      else this.settleError(turn, new Error("agy provider turn was cancelled"));
    };
    turn.onAbort = onAbort;
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  }
  return new Promise<DriverTurnEnd>((resolve, reject) => {
    turn.phase = { resolve, reject };
    turn.timer = setTimeout(() => {
      // ...
    }, Math.max(1, Math.min(PROVIDER_TURN_TIMEOUT_MS, turn.timeoutMs)));
  });
  ```
- `notifyPark` sets `turn.phase = undefined` after resolving `kind: "parked"`. Both settlement methods mark the turn settled, clear timers/listeners, remove `this.active`, then use optional `phase?.resolve/reject`. A pre-waiter settlement therefore cannot be repaired by another timeout.
- Existing cancellation semantics: a turn with delivered text resolves a partial outcome with `aborted: true`; one with no text rejects. Preserve this distinction.
- `tests/provider-driver.test.ts:267–294` already creates a slow fake turn, calls `notifyPark`, waits for the park, then calls `continueTurn` with rebound callbacks. Match its helpers:
  ```ts
  const driver = track(new AgyProviderDriver());
  const pending = driver.turn({ ...profile, dir }, turnOptions());
  assert.equal(driver.notifyPark({ callId: "c1", toolName: "read", args: {} }), true);
  const parked = await pending;
  ```
  `track` plus `afterEach` closes drivers; temp fake CLI scripts must never touch real agy state.
- Provider round-trips intentionally rebind abort signal, callbacks, and full timeout after user approval. Do not reintroduce the prior phase's stale signal.

## Scope

**Modify only:** `extensions/lib/provider-driver.ts`, `tests/provider-driver.test.ts`, own index row.
**Out of scope:** provider stream content reconciliation, MCP sessions/parks, lock policy, timeout durations, result precedence, public tool schemas, dependencies.
Do not introduce an external state-machine library or a broad rewrite.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import ./tests/resolve-hook.mjs --test tests/provider-driver.test.ts` | All pass |
| Consumers | `node --import ./tests/resolve-hook.mjs --test tests/provider.test.ts` | All pass |
| Full gate | `npm test && npm run typecheck && npm run pack:check` | Exit 0 |
| Scope | `git diff --check; git diff --name-only; git status --short` | Scoped changes only |

## Steps

### Step 1: Add bounded already-aborted-resume cases

Add a suite named `provider cancelled resume settlement`. Start a fake driver turn, park it, then resume using `AbortSignal.abort()` and a short timeout. An empty-text turn must reject promptly with cancellation. A turn that streamed text before parking must resolve a partial outcome with `aborted: true` and preserve text. Use a ref'd, bounded race guard (for example 500ms) so the old bug reports a failing assertion instead of hanging the test process forever. Clear the guard in `finally`; always close the driver.

Prefer event/readiness synchronization in the local fake harness. If adding controls to the fake helper within this test file, retain existing test behavior. Do not fabricate a matching result that hides the missing waiter.

**Verify:** `node --import ./tests/resolve-hook.mjs --test --test-name-pattern="provider cancelled resume settlement" tests/provider-driver.test.ts` → cases fail on the old code because the race guard wins.

### Step 2: Establish the continuation phase before any settlement

Move continuation setup inside the new promise executor: install `turn.phase` first, rebind state/callbacks/signal and remove the previous listener, then register the new listener and synchronously check `aborted`. If abort settles the turn, return immediately; do not install a timeout on the already-settled record. Preserve error messages and the partial-text cancellation result.

Keep all settlement paths idempotent. Invalid continuation calls (closed driver, no suspended turn, lost child) must still fail promptly. If the optional signal is omitted, preserve existing documented behavior rather than changing signal ownership as an unrelated cleanup.

**Verify:** named suite → promptly passes both partial and empty cases; `npm run typecheck` → exit 0.

### Step 3: Protect subsequent turns and rebound listeners

Add tests for cancellation immediately after normal resume, harmless abort of an obsolete previous-phase signal after a new signal is bound, and a new turn succeeding after a cancelled resume respawns its child. Confirm no stray timer later kills that fresh process; wait past the cancelled continuation's configured short deadline and verify driver state/reuse remains valid.

Keep existing suspended-wall-timeout and callback-rebinding behavior intact. Do not increase timeouts to make tests pass.

**Verify:** focused command and consumer command → all pass. Full gate → exit 0. Scope/whitespace checks → clean; update your index row.

## Test plan

Use the persistent fake CLI already in `tests/provider-driver.test.ts`, `track`, and strict assertions. Cover empty/partial text on pre-aborted resume, immediate post-resume abort, stale signal isolation, no late timeout after settlement, and respawn. Every failure guard is bounded and cleaned.

## Done criteria

- [ ] Pre-aborted empty resumes reject and partial resumes resolve as aborted within the test guard.
- [ ] There is a phase waiter before cancellation can call settlement.
- [ ] No timer is armed after an immediate settlement.
- [ ] Old abort signals cannot cancel a resumed turn using a new signal.
- [ ] A subsequent turn remains usable; all focused/full gates pass.
- [ ] Only scoped files/index changed.

## STOP conditions

Stop if cancellation requires changing `ProviderTurnRunner` or MCP callback APIs, results no longer distinguish partial and empty cancellations, or another worker has conflicting edits in the continuation function. Preserve already-landed terminal-cap changes from the preceding plan. Stop after two reasonable failed attempts at a gate.

## Maintenance notes

The invariant is waiter-before-settlement, not merely a special-case `if (signal.aborted)` at one call site. Apply it to future resume/teardown paths and keep timers/listeners owned by the currently live phase.

