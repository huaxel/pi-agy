# Plan 008: Design native provider token usage accounting

> **Executor instructions:** Read this entire plan, follow the steps in order, and run each verification. Do not improvise around STOP conditions. Update only your status row in `plans/README.md` when complete, unless the reviewer owns the index.
>
> **Drift check (first):** `git diff --stat 1bf9d29..HEAD -- extensions/lib/stream.ts extensions/lib/provider-driver.ts extensions/lib/provider.ts tests/stream.test.ts tests/provider-driver.test.ts tests/provider.test.ts`. Also run `git status --short` and inspect uncommitted changes. Compare the excerpts below with live code. Any material mismatch requires an updated plan before editing; preserve other workers' changes.

## Status

- **Priority:** P2
- **Effort:** S (design/spike only; subsequent implementation likely M)
- **Risk:** LOW (report only)
- **Depends on:** plans/005-preserve-authoritative-terminal-provider-responses.md, plans/006-settle-provider-resumes-with-already-aborted-signals.md
- **Category:** direction
- **Planned at:** commit `1bf9d29`, 2026-11-11
- **Execution review:** DONE — design complete; implementation unstarted. [Reviewed design and explicit implementation blockers](evidence/008-provider-usage-design.md); [independent approval](evidence/007-008-independent-design-review.md). Native session-cumulative scope verified from official docs; no invented inclusion/pricing rules.

## Repository and execution conventions

This is `@juanbenjumea/pi-agy` 0.7.9: an ESM TypeScript Pi extension distributed as source through npm. Delegation tools launch the Antigravity CLI; provider turns use a persistent process and a localhost MCP bridge. There is no compiler-output build, lint script, or `just ci` gate. Use explicit `.js` relative imports in TypeScript, strict types, `node:test`, and `node:assert/strict`. Tests resolve sibling TypeScript through `tests/resolve-hook.mjs`; invoke the exact commands below, not a guessed test-runner filter.

The audited environment used Node 24.22.1. CI uses Node 22, while the manifest claims >=20.3.0; do not change runtime support in this task. Initial gates passed with installed dependencies: 305 tests, typecheck, package dry-run. Those installed versions differed from the lockfile, so do not describe them as clean-install proof.

Work on an operator-provided branch/worktree or an isolated branch named `advisor/008-design-native-provider-token-usage-accounting`. **Do not commit, push, publish, deploy, open issues/PRs, or merge without separate explicit authorization.** If authorized to commit, match Conventional Commit history (for example `23a0bf2 refactor: simplify agy extension guidance and modules`).

## Why this matters

Provider messages currently report output characters as tokens, leave input/cache usage at zero, and expose no native usage from the driver result. This makes token totals misleading, especially for non-ASCII text and tool round-trips. Design a native-usage path with explicit unknown-data and phase-counting semantics before implementing it.

**This is a design plan, not authorization to edit provider code.** Its product is a reviewed mapping and test specification, not a speculative numeric estimate disguised as native usage.

## Current state

- `extensions/lib/stream.ts:9–15` already defines native fields:
  ```ts
  export interface AgyUsage {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  }
  ```
- `accumulateRunResult` copies top-level and nested-result usage when objects exist:
  ```ts
  if (typeof parsed.result.usage === "object" && parsed.result.usage !== null) {
    next.usage = parsed.result.usage;
  }
  ```
  It does not prove runtime numeric validity or settle whether counters are cumulative.
- `extensions/lib/provider-driver.ts` keeps this data in `turn.runResult`, but `ProviderDriverOutcome` returns only text, flags, conversationId, activity and deniedActions. `ProviderTurnResult` in `extensions/lib/provider.ts:123–135` has the same omission.
- `extensions/lib/provider.ts:629–635`:
  ```ts
  onText: (delta) => {
    const index = ensureText();
    const block = output.content[index] as { text: string };
    block.text += delta;
    output.usage.output += delta.length;
    stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
  },
  ```
  Output usage starts at zero; final `totalTokens` adds input/output/cacheRead/cacheWrite. A terminal-only answer can report zero output tokens while a streamed answer reports character count.
- The audited installed `@earendil-works/pi-ai/dist/types.d.ts:270–291` defines `Usage` with numeric input/output/cacheRead/cacheWrite/totalTokens and a cost object. Optional `reasoning` is a **subset of output**, not an extra additive token bucket. Verify the version established by the locked baseline; do not assume every supported peer version has this optional field.
- Parked tool calls produce multiple Pi assistant phases for one agy driver turn. Simply attaching cumulative native usage to each Pi phase double-counts one turn.
- Test convention: `tests/stream.test.ts` exercises envelope accumulation; driver tests use a local persistent fake emitting deterministic JSON; provider tests use recording factories/static runners and a real pi-ai stream. These are appropriate fixture layers.

## Scope

**Write only:** `plans/evidence/008-provider-usage-design.md` (create), own index row.
**Read/run:** audited modules/tests, installed peer type declarations, relevant primary agy documentation or existing sanitized fixtures.
**Out of scope:** production/test/manifest edits, live inference, reading personal conversation logs, inventing pricing, changing quota fallback/model selection, rewriting delegation usage parsing.
Do not claim unknown counts are real zero counts. Propose a documented structural fallback compatible with Pi's required numeric fields.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Usage/parser baseline | `node --import ./tests/resolve-hook.mjs --test tests/stream.test.ts tests/provider-driver.test.ts tests/provider.test.ts` | All pass |
| Native-field trace | `grep -n 'input_tokens\\|output_tokens\\|thinking_tokens\\|cache_read_tokens\\|usage' extensions/lib/stream.ts extensions/lib/provider-driver.ts extensions/lib/provider.ts` | Trace locations for the report |
| Types | `npm run typecheck` | Exit 0 |
| Full gate | `npm test && npm run typecheck && npm run pack:check` | Exit 0 or unrelated failure recorded |
| No source edits | `git diff --exit-code -- extensions tests package.json package-lock.json .github` | Exit 0 against starting implementation state |

## Steps

### Step 1: Trace usage provenance and establish unknowns

Create the report with `## Provenance` and `## Native semantics`. Trace fields from wire envelope through accumulator, driver outcome, runner outcome, and Pi message. Record where data is absent, merely structurally cast, or not validated.

Find primary documentation or already-versioned sanitized fixtures for: whether input includes cached reads, whether output includes thinking, whether total already includes caches/thinking, and whether counts are per-step/per-turn/per-conversation. Do not use a newly generated inference turn or personal raw log. Synthetic fixtures can illustrate alternatives, but cannot prove agy's native semantics. If evidence is unavailable, mark that exact mapping unresolved and recommend a no-fabrication fallback.

**Verify:** native-field trace command → locations recorded; `test -s plans/evidence/008-provider-usage-design.md` → exit 0. Each semantics claim has a primary source or a clearly labeled unknown.

### Step 2: Specify a typed normalization contract

Write `## Proposed data flow`, `## Field mapping`, and `## Missing and invalid data policy`. Recommend forwarding optional native usage through `ProviderDriverOutcome` and `ProviderTurnResult`, then normalizing once at the Pi boundary. Specify acceptance of only finite, nonnegative, safe numeric counts; explicitly decide treatment of fractions, numeric strings, missing keys, negative values, Infinity/NaN, and inconsistent totals. Do not silently trust the existing cast.

Define how to map input/output/cacheRead/reasoning without double-counting. Keep money/cost fields at zero with an explicit “unpriced” explanation unless a verified price source exists; do not infer dollars from quota fractions or Pi's unrelated provider catalog. Remove the character-as-token convention in the later implementation, not during this spike.

For missing data, recommend zero required structural fields plus an explicit diagnostic/provenance distinction saying “usage unavailable,” rather than pretending zero is measured. Specify where that distinction can live without breaking Pi's event protocol; if no supported public metadata slot exists, recommend diagnostics/documentation rather than adding an untyped event field.

**Verify:** `npm run typecheck` → baseline passes. The field-mapping table names every native and Pi field, its validated precondition, and fallback; no unresolved native semantics is presented as a settled arithmetic formula.

### Step 3: Decide ownership across tool phases and partial turns

Write `## Phase accounting`. Recommend emitting zero/unavailable native usage on intermediate `toolUse` phases and attributing one complete native usage snapshot to the terminal phase, if the CLI reports per-turn cumulative totals. This avoids duplicate counting across parks. Specify what to do if the CLI instead reports deltas: normalization must use the documented counter scope and not blindly sum snapshots.

Define behavior for aborted/timed-out turns with partial native usage, failed terminal envelopes, no native usage, multiple parks, corrections of streamed text, and resumed drivers across separate user turns. Preserve stop reasons and final content semantics from the repaired runtime. Usage must not depend on response text length, Unicode encoding, or the number of text deltas.

**Verify:** existing usage/parser baseline command → all pass. Report includes a numeric worked example for two parks plus terminal completion and shows that summing Pi message totals counts the native turn exactly once. If semantics remain unknown, label the example conditional and block implementation of that mapping.

### Step 4: Write a test-first implementation handoff

Write `## Acceptance tests`, `## File-level implementation outline`, `## Decisions and blockers`, and `## Verification results`. Name the exact interfaces/functions to change later and enumerate deterministic fixture cases:
- full native usage with cache/thinking,
- absent usage,
- zero measured usage distinct from missing,
- invalid/negative/nonfinite/fractional fields,
- Unicode output with unchanged native counts,
- terminal-only and streamed answers with identical usage,
- two parks and one terminal snapshot with no double-count,
- abort/timeout and terminal failure,
- mismatched explicit total versus component sum.

Follow existing test layering, not a new test framework. Include expected concrete normalized counts only for semantics backed by evidence. Estimate effort and list which unknowns block implementation versus merely reduce diagnostic fidelity.

**Verify:** full gate → record actual result; no-source-edit command and `git diff --check` → clean. Update the index as design complete, implementation not started.

## Test plan

No tests are edited. Existing parser/driver/provider suites establish the baseline. The deliverable specifies future deterministic tests with inputs, expected normalized results, and counter provenance. Native semantics are not to be “verified” by synthetic fixtures alone.

## Done criteria

- [ ] A self-contained report has all ten named sections and a complete native-to-Pi mapping.
- [ ] Numeric validation, unavailable-vs-zero, cost, counter scope, and partial-turn policies are explicit.
- [ ] At least one multi-park worked example demonstrates no double-counting.
- [ ] Every unverified native-semantic assumption is labeled and linked to an implementation blocker.
- [ ] Future acceptance tests cover all ten listed cases with exact expectations where supported.
- [ ] No production changes; baseline gates and remaining limits recorded; index says design-only.

## STOP conditions

Stop and report if source data requires private session logs, inference quota, credentials, or invented prices. If thinking/cache inclusivity or usage scope cannot be verified, finish the report with those implementation blockers; do not guess. If Pi's peer APIs differ materially from the excerpt, document the supported contract before proposing fields. Do not silently turn this design task into implementation.

## Maintenance notes

Token counts are protocol data, not display estimates. Counter scope matters as much as field spelling; any change to tool parking, native cumulative counters, or peer `Usage` semantics must revisit the phase-accounting tests. Missing usage should remain visibly unknown, and cost should remain explicitly unpriced until a trustworthy source exists.

