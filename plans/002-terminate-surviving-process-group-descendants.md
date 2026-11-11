# Plan 002: Terminate surviving process-group descendants

> **Executor instructions:** Read this entire plan, follow the steps in order, and run each verification. Do not improvise around STOP conditions. Update only your status row in `plans/README.md` when complete, unless the reviewer owns the index.
>
> **Drift check (first):** `git diff --stat 1bf9d29..HEAD -- extensions/lib/spawn.ts tests/regression.test.ts`. Also run `git status --short` and inspect uncommitted changes. Compare the excerpts below with live code. Any material mismatch requires an updated plan before editing; preserve other workers' changes.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (process-group signaling)
- **Depends on:** plans/001-establish-the-locked-dependency-verification-baseline.md — passing baseline, or operator-approved documented exception
- **Category:** bug / safety
- **Planned at:** commit `1bf9d29`, 2026-11-11

## Repository and execution conventions

This is `@juanbenjumea/pi-agy` 0.7.9: an ESM TypeScript Pi extension distributed as source through npm. Delegation tools launch the Antigravity CLI; provider turns use a persistent process and a localhost MCP bridge. There is no compiler-output build, lint script, or `just ci` gate. Use explicit `.js` relative imports in TypeScript, strict types, `node:test`, and `node:assert/strict`. Tests resolve sibling TypeScript through `tests/resolve-hook.mjs`; invoke the exact commands below, not a guessed test-runner filter.

The audited environment used Node 24.22.1. CI uses Node 22, while the manifest claims >=20.3.0; do not change runtime support in this task. Initial gates passed with installed dependencies: 305 tests, typecheck, package dry-run. Those installed versions differed from the lockfile, so do not describe them as clean-install proof.

Work on an operator-provided branch/worktree or an isolated branch named `advisor/002-terminate-surviving-process-group-descendants`. **Do not commit, push, publish, deploy, open issues/PRs, or merge without separate explicit authorization.** If authorized to commit, match Conventional Commit history (for example `23a0bf2 refactor: simplify agy extension guidance and modules`).

## Why this matters

Cancelling a delegation or provider turn must stop descendant tools, not merely agy itself. A harmless local probe reproduced a SIGTERM-resistant grandchild still alive after the parent's exit and the two-second escalation interval. Such a tool could continue editing files after cancellation is reported.

## Current state

- `extensions/lib/spawn.ts:45–77` exports `killProcessTree(child): void`. Every agy spawn managed here uses a detached POSIX process group.
- The initial and escalation guards currently depend on the leader:
  ```ts
  if (child.exitCode !== null || child.signalCode !== null) return;
  // ...
  const escalate = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
  ```
  A leader exiting in response to SIGTERM disables SIGKILL for its still-live descendants.
- `tests/regression.test.ts:39–89` has a `process tree kill` suite, but its writer does not resist SIGTERM. Its already-exited fake-child test only asserts no throw.
- Match the existing test convention:
  ```ts
  import assert from "node:assert/strict";
  import { describe, it } from "node:test";
  // Existing tests skip POSIX-specific assertions on win32.
  if (process.platform === "win32") return;
  ```
- README promises that timeouts/cancellations stop the agy process tree. Windows currently falls back to direct-child kill; do not silently claim to fix that separate limitation.

## Scope

**Modify only:** `extensions/lib/spawn.ts`, `tests/regression.test.ts`, your index row.
**Do not modify:** lock algorithms, timeout budgets, completion-versus-cancellation precedence, public tool schemas, background states, provider continuation, dependencies, README, workflows.
Keep the exported synchronous signature and two-second grace period. This plan repairs descendant escalation, not the separate question of waiting for group death before workspace-lock release.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import ./tests/resolve-hook.mjs --test --test-name-pattern="process tree kill" tests/regression.test.ts` | Selected tests pass |
| Full gate | `npm test && npm run typecheck && npm run pack:check` | Exit 0 |
| Scope | `git diff --check; git diff --name-only; git status --short` | No whitespace errors; only scoped changes |

## Steps

### Step 1: Add bounded regressions before changing signaling

Extend the existing suite with real POSIX processes launched from `process.execPath`, not an external agy binary. A detached parent spawns a child in its group. The child installs a SIGTERM handler that does not exit and sends a readiness marker; only then may the test cancel. The parent exits on SIGTERM. Verify the parent exited, then poll within a bounded five-second deadline for the descendant/group to disappear. Give the test writer a short self-expiry and clean up the known task-owned group with SIGKILL in `finally`, even on assertion failure. Avoid race-prone startup sleeps and never signal a made-up negative PID.

Add a second case where the leader already exited but a known live task-owned group remains before `killProcessTree` is called. Replace the existing already-exited fake with `pid: 123456`: after this fix, that fabricated id could be signaled. Use a fake with no PID for the direct-child no-throw path and a genuinely reaped task-owned group for group-absence coverage. Use bounded polling and platform-specific skips; a zombie that no longer runs must not be mistaken for an active writer.

**Verify:** focused command → new surviving-descendant cases fail on the old implementation; existing cases still pass or platform-skip. No children remain after the run.

### Step 2: Separate group lifecycle from direct-child lifecycle

Capture the valid POSIX group id from the detached child's PID. Do not suppress group SIGTERM/SIGKILL solely because `exitCode` or `signalCode` is set. Schedule escalation for a group that may remain alive; treat ESRCH as already gone. Retain guarded direct-child fallback when no usable POSIX group exists and retain the existing Windows behavior. Every asynchronous timer callback must be exception-safe; do not introduce uncaught signaling errors.

Keep the grace period and timer unref semantics unchanged in this scoped fix. Do not generalize this helper to arbitrary non-detached processes. Add a concise comment explaining why leader exit is insufficient evidence of group death.

**Verify:** focused command → all selected tests pass, including both new regressions. `npm run typecheck` → exit 0.

### Step 3: Check cancellation consumers

Run the full gate and inspect the diff. Existing execution/provider/background tests must preserve their completed-result and abort behavior; do not change them to excuse a regression. Record the two-second grace and unref limitation as residual behavior, not proof that descendants cannot run during the grace period.

**Verify:** full gate → exit 0; scope commands → no out-of-scope implementation changes. Update your index row.

## Test plan

Use `tests/regression.test.ts`'s existing process-tree suite as the exemplar. Cover leader exits first, leader already exited, child ignores SIGTERM, ordinary group shutdown, and genuinely absent processes. Do not run inference. Test resources must be owned, self-expiring, and cleaned in `finally`.

## Done criteria

- [ ] Both real descendant-survival regressions fail before the fix and pass afterward on POSIX.
- [ ] Focused suite and full gate exit 0.
- [ ] No signaling branch relies on leader exit as proof that a POSIX group is gone.
- [ ] No Windows-tree-kill or lock-release guarantee is claimed.
- [ ] `git diff --check` is clean; only scoped files/index changed.

## STOP conditions

Stop if the helper is used on non-detached POSIX children, safe group ownership cannot be established, a reliable bounded test requires signaling unrelated processes, or correctness requires changing workspace-lock release/API contracts. Report Windows limitations rather than adding an unreviewed `taskkill` shell path. Stop after two failed reasonable attempts at any gate.

## Maintenance notes

Review every new caller for `detached: true` on POSIX. PID/group reuse and host-process exit remain lifecycle concerns; this patch must not grow into an unsupported process supervisor. A separate design is needed if cancellation must await complete group death before releasing the workspace lock.

