# Plan 013: Keep result payloads behind collect

Status TODO · Priority P2 · Effort S · Risk LOW · Confidence HIGH
Category bug/API simplification. Depends on 012 for editing order only.

## Why and current state
extensions/tools.ts:459–462 includes task.text in completed status content, despite
the summary-only comment. The branch is `task.state === "done"`, and it calls
`truncate(task.text ?? "(empty response)")`.
tests/background.test.ts:359 "keeps full payloads out of list and status details"
only checks `assert.equal("text" in status.details.task, false)`, then verifies
collect includes payload-data. It does not check status.content.

## Scope
extensions/tools.ts and tests/background.test.ts only.
Do not change task storage, timers, cancellation, retention, truncation policy,
handle formats, or other tools. Completed status text intentionally changes;
collect's data contract does not.

## Steps and tests
1. Extend the existing withFakeAgy/registration test with a unique result marker.
   After terminal settlement, assert repeated status and list contain no marker
   in content or details, while state and conversation id remain available.
   Keep readiness polling and fixture cleanup, not new short sleeps.
   Verify: `node --import ./tests/resolve-hook.mjs --test tests/background.test.ts`
   fails specifically on the status content marker.
2. Replace only the completed-response status branch with an instruction to
   collect the result. Preserve running progress and failure/cancellation text.
   Verify the focused command passes.
3. Assert collect still returns the marker and execution details, removes the
   record, and subsequent status reports unknown handle. Run the full gate.

## Done and maintenance
Tests prove repeated status is non-consuming and result-free, collect retrieves
and releases, and running/error/cancelled behavior remains intact. Do not assert
arbitrary byte limits on progress or task summaries. Status/list observe;
collect retrieves and releases. Future renderers must not expose task.text during
polling. No files beyond scope and the index may change.


## Execution contract
Planned at **8a5d592**, 2026-11-11. Inspect `git status --short`; preserve unrelated work. Run `git diff --stat 8a5d592..HEAD -- extensions tests` and compare scoped code against the excerpts below; stop on unexplained drift. No commits, pushes, installs, publication, or live inference authorized. Use an isolated worktree when dispatched. Match strict ESM TypeScript, .js imports, node:test and node:assert/strict conventions.

## Full verification gate
Run `npm test`, `npm run typecheck`, `npm run pack:check`, and `git diff --check`: each must exit 0. Confirm `git status --short` contains only scoped changes and the plan-index status update. Advisor baseline was 341/341 tests, typecheck, and 43 pack entries; rerun rather than borrowing that evidence. No just ci or lint script exists. Stop if dependencies are missing rather than installing unreviewed changes.

## General STOP conditions
Stop if scope must expand, excerpts have drifted, behavior contradicts this plan, or checks fail twice after reasonable correction. Never weaken checks or revert unrelated work. Update only this plan's status row in plans/README.md after verified completion.
