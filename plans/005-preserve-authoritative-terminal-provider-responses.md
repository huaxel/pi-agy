# Plan 005: Preserve authoritative terminal provider responses

> **Executor instructions:** Read this entire plan, follow the steps in order, and run each verification. Do not improvise around STOP conditions. Update only your status row in `plans/README.md` when complete, unless the reviewer owns the index.
>
> **Drift check (first):** `git diff --stat 1bf9d29..HEAD -- extensions/lib/provider.ts extensions/lib/provider-driver.ts tests/provider.test.ts tests/provider-driver.test.ts`. Also run `git status --short` and inspect uncommitted changes. Compare the excerpts below with live code. Any material mismatch requires an updated plan before editing; preserve other workers' changes.

## Status

- **Priority:** P1
- **Effort:** S to M (stream and park/resume regressions)
- **Risk:** MED
- **Depends on:** approved001 baseline; approved003 for serialized provider ownership; approved009 test-fixture prerequisite for the verified003+009 bundle
- **Category:** bug
- **Planned at:** commit `1bf9d29`, 2026-11-11
- **Execution review:** APPROVE in isolated003+009+005 stack; independent319/319, typecheck and packaging pass. [Review and incremental patch](evidence/005-terminal-response-review.md). No source applied to main.

## Accepted execution baseline

Start a fresh task-owned detached worktree at `1bf9d29` and apply the exact `plans/patches/003-tool-catalog.patch` plus `plans/patches/009-timing-tests.patch` (009 SHA-256 `98a0d48a971e19cb4c6528ff89530cbc7f92f6d34c9baffd91139982aa013f51`). The original checkout and prior worktrees remain read only. The accepted bundle independently passed314/314 tests, typecheck and packaging twice on Node22.23.4/npm10.9.9; [acceptance evidence](evidence/009-timing-followup-review.md).

Before editing, compare all prerequisite file bytes to the accepted integration tree supplied by the reviewer and snapshot the four005-owned files under ignored `.pi/baseline/`. Record hashes. The resulting expected uncommitted changes are prerequisites, not005 edits. Readiness changes in `tests/provider-driver.test.ts` and active-tool forwarding/registration tests must be preserved. The production target excerpts below still match the accepted tree; only line positions/test context shifted.

Export005 as an **incremental** patch against that immutable003+009 snapshot, not a replacement of either earlier patch. No commits, staging, hard reset, clean, additional worktrees or source edits in other checkouts. Reviewer maintains the index.

## Repository and execution conventions

This is `@juanbenjumea/pi-agy` 0.7.9: an ESM TypeScript Pi extension distributed as source through npm. Delegation tools launch the Antigravity CLI; provider turns use a persistent process and a localhost MCP bridge. There is no compiler-output build, lint script, or `just ci` gate. Use explicit `.js` relative imports in TypeScript, strict types, `node:test`, and `node:assert/strict`. Tests resolve sibling TypeScript through `tests/resolve-hook.mjs`; invoke the exact commands below, not a guessed test-runner filter.

The audited environment used Node 24.22.1. CI uses Node 22, while the manifest claims >=20.3.0; do not change runtime support in this task. Initial gates passed with installed dependencies: 305 tests, typecheck, package dry-run. Those installed versions differed from the lockfile, so do not describe them as clean-install proof.

Work on an operator-provided branch/worktree or an isolated branch named `advisor/005-preserve-authoritative-terminal-provider-responses`. **Do not commit, push, publish, deploy, open issues/PRs, or merge without separate explicit authorization.** If authorized to commit, match Conventional Commit history (for example `23a0bf2 refactor: simplify agy extension guidance and modules`).

## Why this matters

An agy driver can stream provisional text and return a fuller or corrected terminal response. The driver deliberately selects that terminal response, but the outer Pi stream ignores it whenever a single text delta arrived. A focused probe streamed `partial`, returned `partial plus terminal remainder`, and observed only `partial` in the completed Pi message.

## Current state

- `extensions/lib/provider-driver.ts:563–566`:
  ```ts
  // The terminal response is authoritative when present ...
  const text = result.response_complete && result.response ? result.response : turn.text;
  this.settleDone(turn, { text });
  ```
- The same driver caps live `turn.text` at `MAX_TURN_TEXT_CHARS = 512_000`; its shared stream accumulator has a different, larger response cap. Do not accidentally bypass the provider cap while making terminal text authoritative.
- `extensions/lib/provider.ts:779–798` uses `result.text` only when no delta arrived:
  ```ts
  if (textIndex === -1) {
    // ...
    const fallback = result.text ||
      (result.activity.length > 0 ? result.activity.join("\n") : "(agy returned no text)");
    // ...
  } else {
    const block = output.content[textIndex];
    let finalText = (block as { text: string }).text;
    if (result.truncated) finalText += "\n\n[truncated: agy response exceeded the provider cap]";
  ```
  Aborted/timeout/denial annotations are also only applied in the streamed branch.
- Provider parks emit a shadow toolCall and end a Pi phase; a later matching toolResult resumes the same driver with new callbacks. Do not concatenate old phase text onto a terminal answer.
- `tests/provider.test.ts` has `createRecordingFactory`, `makeStaticRunner`, `withIsolatedAgentDir`, a `provider tool round-trip` suite, and a real pi-ai async-iterable stream test. Existing static-runner convention:
  ```ts
  run: async (request) => ({ kind: "done" as const, result: await run(request) })
  ```
- `tests/provider-driver.test.ts`'s persistent fake emits live text `live-1 ` and terminal `turn-response`, proving the two may differ. Match existing `node:test` and strict-assert style.

## Scope

**Modify only:** the four drift-check files and own index row.
**Out of scope:** accounting/token estimates, catalog forwarding except preserving already-landed work, prompt serialization, transport sessions, permission policies, execution/delegation results, generic stream parser semantics, dependency changes.
Keep streaming deltas and Pi's event protocol. This is not permission to add a second assistant message or a new message type.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import ./tests/resolve-hook.mjs --test tests/provider.test.ts tests/provider-driver.test.ts` | All pass |
| Types | `npm run typecheck` | Exit 0 |
| Full gate | `npm test && npm run typecheck && npm run pack:check` | Exit 0 |
| Scope | `git diff --check; git diff --name-only; git status --short` | Scoped changes only |

## Steps

### Step 1: Capture terminal-versus-streamed regressions

Add a suite named `provider terminal response reconciliation`. With a static runner, emit a prefix and return a longer terminal answer. Assert both `text_end.content` and the terminal `done.message.content` equal the terminal answer. Also emit a draft that is not a prefix of the final answer; final content must replace the draft, not concatenate it.

Add no-delta coverage with truncation, denied-action warnings, and partial timeout/abort flags; the annotations must not disappear merely because text arrived only at the terminal envelope. Use isolated agent state and bounded completion waits.

**Verify:** `node --import ./tests/resolve-hook.mjs --test --test-name-pattern="provider terminal response reconciliation" tests/provider.test.ts` → the new mismatch/annotation tests fail on the old implementation for the asserted reasons.

### Step 2: Unify terminal message construction

For a completed driver phase, use `result.text` as the canonical final answer; choose the existing activity/empty fallback only when no answer exists. Do not derive final text solely from accumulated callbacks. Build truncation/denial/abort/timeout notes in one shared path for both delta and no-delta responses. Mutate the output text block before emitting `text_end` and `done`, so both views agree. Preserve `length` for timeout and `aborted` for cancellation.

When terminal text is a strict extension of live text, emitting the missing suffix as a delta is reasonable; do not emit an append delta for a non-prefix correction. The final `text_end`/message must be authoritative in either case. Inspect the existing real-stream test/API event types before altering event shapes; keep start/end pairing and content indices valid.

**Verify:** named suite → all pass; `npm run typecheck` → exit 0.

### Step 3: Keep terminal answers inside provider bounds

At driver terminal selection, enforce `MAX_TURN_TEXT_CHARS` on terminal text too and set `truncated` when needed. Use one local bounded selection helper if useful; do not change the separate delegation parser's million-character contract. Preserve existing denied-action and terminal-failure precedence.

Add a driver regression with terminal response longer than 512,000 characters and short/no live deltas. Assert returned text stays within the cap and `truncated === true`. No claim about original completeness may be made after capping.

**Verify:** focused command → cap tests and existing driver tests pass; types → exit 0.

### Step 4: Exercise park/resume and the real Pi event stream

Extend the fake round-trip test: first phase emits distinct pre-tool commentary and parks; resume emits a short draft and returns a distinct complete terminal answer. The final resumed Pi message must match that answer plus applicable notes without duplicating draft/pre-tool text. Keep the prior parked phase's text and toolCall untouched.

Use the real `createAssistantMessageEventStream` test pattern near `tests/provider.test.ts:723`: iterate events and inspect the terminal result, not only a custom recorder. Include an unchanged delta/final case to prove ordinary streams still work.

**Verify:** focused command and full gate → exit 0. Scope commands → clean and bounded; update your index row.

## Test plan

Cover prefix completion, corrected non-prefix final text, no-delta final text with notes, identical final/live output, terminal cap, timeout/abort stop reasons, and resumed final answers. Do not assert token counts: usage accounting is a separate design plan. Avoid live inference.

## Done criteria

- [ ] A streamed prefix cannot suppress the rest of a terminal answer.
- [ ] Corrected final answers replace rather than concatenate provisional text.
- [ ] Delta/no-delta paths preserve the same warnings and partial-state indicators.
- [ ] Terminal driver text is capped at 512,000 characters with an explicit flag.
- [ ] Park/resume and real pi-ai stream tests pass; all project gates pass.
- [ ] Only scoped files/index changed; no unrelated formatting churn.

## STOP conditions

Stop if the current SDK cannot represent final corrected content without a protocol change, terminal response semantics no longer match the excerpt, or fixing resumed content requires changing tool execution or transcript ownership outside scope. Prior catalog changes are expected drift: compare and preserve them; stop only on a conflicting material change. Stop after two failed reasonable attempts at a gate.

## Maintenance notes

Treat callbacks as provisional display updates and the terminal outcome as authoritative content. Preserve terminal bounds whenever result handling changes. New annotations must apply to both output paths. Coordinate later usage-accounting edits in this same block rather than mixing them into this fix.

