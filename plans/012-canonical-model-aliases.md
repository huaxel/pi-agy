# Plan 012: Define delegation model aliases once

Status TODO · Priority P2 · Effort S · Risk LOW · Confidence HIGH
Category tech-debt. Depends on: none.

## Why and current state
The alias union, list, and two tool schemas repeat eight model names.
extensions/lib/cli.ts:4–24 separately declares AgyModel and
`export const AGY_MODEL_ALIASES: readonly AgyModel[] = [`.
extensions/tools.ts:83 and :510 repeat `Type.Literal("flash-low")` and the other aliases.
Preserve alias order, schema descriptions, defaults, and exports. Provider catalog
grouping has different semantics and must remain separate.

## Scope
extensions/lib/cli.ts, extensions/tools.ts, tests/cli-args.test.ts;
create tests/model-schema.test.ts. No provider, discovery, effort, fallback-order,
permission, config, or dependency changes.

## Steps and tests
1. Capture both registered tool schemas using a fake registerTool, following
   the registration fixtures in tests/background.test.ts and node:test style
   in tests/cli-args.test.ts. Assert exact ordered aliases, execute default,
   usage without default, and unknown-value rejection through installed TypeBox.
   Verify: `node --import ./tests/resolve-hook.mjs --test tests/cli-args.test.ts tests/model-schema.test.ts`
   passes before refactoring.
2. Make AGY_MODEL_ALIASES an as-const tuple; derive AgyModel as
   `typeof AGY_MODEL_ALIASES[number]`. Keep isAgyModel behavior.
   Add a small schema factory in tools.ts deriving literals from the tuple;
   preserve each use's metadata. No unsafe tuple casts: stop if TypeBox's
   installed typing prevents checked construction.
   Verify focused tests and `npm run typecheck` pass.
3. Run the full gate and inspect schema/output diffs.

## Done and maintenance
All eight aliases accepted, unknown values rejected, both schemas match the
canonical inventory, and metadata remains unchanged. One literal alias inventory
remains across cli.ts/tools.ts. Typed MODEL_MAP and CATALOG_PATTERNS objects
elsewhere intentionally remain exhaustive. Future aliases update the tuple and
these mappings, not independent schemas.


## Execution contract
Planned at **8a5d592**, 2026-11-11. Inspect `git status --short`; preserve unrelated work. Run `git diff --stat 8a5d592..HEAD -- extensions tests` and compare scoped code against the excerpts below; stop on unexplained drift. No commits, pushes, installs, publication, or live inference authorized. Use an isolated worktree when dispatched. Match strict ESM TypeScript, .js imports, node:test and node:assert/strict conventions.

## Full verification gate
Run `npm test`, `npm run typecheck`, `npm run pack:check`, and `git diff --check`: each must exit 0. Confirm `git status --short` contains only scoped changes and the plan-index status update. Advisor baseline was 341/341 tests, typecheck, and 43 pack entries; rerun rather than borrowing that evidence. No just ci or lint script exists. Stop if dependencies are missing rather than installing unreviewed changes.

## General STOP conditions
Stop if scope must expand, excerpts have drifted, behavior contradicts this plan, or checks fail twice after reasonable correction. Never weaken checks or revert unrelated work. Update only this plan's status row in plans/README.md after verified completion.
