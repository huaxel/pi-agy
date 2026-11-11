# Plan 014: Normalize conversation selection once

Status TODO · Priority P2 · Effort M · Risk MED · Confidence HIGH
Category tech-debt. Depends on 012 and 013 for shared-file editing order.

## Why and current state
conversation_id, continue, and new_session express one choice through overlapping
flags. Consolidate their pure interpretation, not asynchronous execution policy.
- extensions/tools.ts:199–201 derives isResume with
  `params.conversation_id || params.continue || params.new_session === false`.
- extensions/command-run.ts:130 builds
  `new_session: run.conversation_id || run.continue ? false : true`.
- extensions/lib/execute.ts:125–157 resolves sessions under withDirLock, using
  `const resumesLatest = options.continue || options.new_session === false;`.
- execute.ts:351 rejects continue plus conversation_id and new_session=true
  plus either resume option.
- The tool reads historical agents before confirmation; execution repeats the
  lookup under lock. These reads have distinct temporal responsibilities.
- CLI --continue and new_session=false are NOT equivalent: the latter may
  resolve a stored conversation id. Preserve both behaviors.

## Scope
extensions/tools.ts, extensions/command-run.ts, extensions/lib/execute.ts,
tests/command.test.ts, tests/execution.test.ts.
Create extensions/lib/request.ts and tests/request.test.ts.
No provider, storage, locking, subprocess, config, schema, permission,
model-pricing, or dependency changes. All public flags, including tier, remain.

## Target contract
Use a pure discriminated union:
```ts
type ConversationSelection =
  | { kind: "new" }
  | { kind: "latest"; source: "cli" | "recorded" }
  | { kind: "resume"; id: string };
```
A helper validates public flags and returns this selection. Derive isResume
from it; retain the source distinction when producing existing CLI behavior.
request.ts has no I/O and does not introduce a generic request framework.

## Steps and tests
1. Characterize existing behavior in command/execution tests before moving code.
   Table cases: absent flags; true/false new_session; explicit id; conflicting
   flags; empty id; false continue; recorded-latest with/without history.
   Preserve current errors and truthiness semantics.
   Verify: `node --import ./tests/resolve-hook.mjs --test tests/command.test.ts tests/execution.test.ts`
   passes with characterization coverage.
2. Add the pure normalizer and table-driven tests/request.test.ts. Reject the
   existing conflicting combinations before I/O. Distinguish CLI-latest from
   recorded-latest explicitly.
   Verify: `node --import ./tests/resolve-hook.mjs --test tests/request.test.ts`
   and `npm run typecheck` pass.
3. Route command/tool/executor conversation-choice branches through the helper.
   Keep session/agent reads in their existing positions: preview before approval,
   authoritative resolution under the lock. Do not cache latest across approval.
   Preserve default model, timeout, digest, stream, and context behavior.
   Verify: `node --import ./tests/resolve-hook.mjs --test tests/request.test.ts tests/command.test.ts tests/execution.test.ts`
   passes.
4. Add parity checks for equivalent command/tool inputs: resume suppresses context,
   saved agents restore, conflicts reject before spawn, direct executor calls
   retain validation. Inspect diff for approval/lock movement. Run full gate.
   Obtain independent read-only review before accepting this medium-risk change.

## Done criteria
All table cases pass; existing CLI-continue versus recorded-id assertions remain
unchanged; no approval or lock boundaries move; direct executor validation
remains; full gate passes and scope is respected.

## Specific STOP conditions and maintenance
Stop if implementation requires changing confirmation timing, merging the two
latest semantics, changing defaults, or accepting formerly invalid inputs.
Do not silently turn preview metadata into an approved immutable execution
snapshot: history changes while awaiting a lock and quota-driven model fallback
need a separate design. This plan is the first pure normalization slice, not a
claim that all request preparation is centralized. Provider ownership and SDK
event typing remain deferred.


## Execution contract
Planned at **8a5d592**, 2026-11-11. Inspect `git status --short`; preserve unrelated work. Run `git diff --stat 8a5d592..HEAD -- extensions tests` and compare scoped code against the excerpts below; stop on unexplained drift. No commits, pushes, installs, publication, or live inference authorized. Use an isolated worktree when dispatched. Match strict ESM TypeScript, .js imports, node:test and node:assert/strict conventions.

## Full verification gate
Run `npm test`, `npm run typecheck`, `npm run pack:check`, and `git diff --check`: each must exit 0. Confirm `git status --short` contains only scoped changes and the plan-index status update. Advisor baseline was 341/341 tests, typecheck, and 43 pack entries; rerun rather than borrowing that evidence. No just ci or lint script exists. Stop if dependencies are missing rather than installing unreviewed changes.

## General STOP conditions
Stop if scope must expand, excerpts have drifted, behavior contradicts this plan, or checks fail twice after reasonable correction. Never weaken checks or revert unrelated work. Update only this plan's status row in plans/README.md after verified completion.
