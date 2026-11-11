# Plan 007: Design truthful end-to-end bridge diagnostics

> **Executor instructions:** Read this entire plan, follow the steps in order, and run each verification. Do not improvise around STOP conditions. Update only your status row in `plans/README.md` when complete, unless the reviewer owns the index.
>
> **Drift check (first):** `git diff --stat 1bf9d29..HEAD -- extensions/lib/doctor.ts extensions/command-info.ts extensions/lib/provider.ts extensions/lib/provider-mcp.ts tests/doctor.test.ts tests/live-smoke.ts`. Also run `git status --short` and inspect uncommitted changes. Compare the excerpts below with live code. Any material mismatch requires an updated plan before editing; preserve other workers' changes.

## Status

- **Priority:** P2
- **Effort:** S (design/spike only; later implementation estimated separately)
- **Risk:** LOW (no production changes)
- **Depends on:** plans/003-forward-active-pi-tools-into-every-provider-turn.md, plans/004-allow-fresh-mcp-sessions-on-a-persistent-workspace-bridge.md, plans/006-settle-provider-resumes-with-already-aborted-signals.md
- **Category:** direction
- **Planned at:** commit `1bf9d29`, 2026-11-11
- **Execution review:** DONE — design complete; implementation unstarted. [Reviewed design](evidence/007-bridge-diagnostics-design.md); [independent approval](evidence/007-008-independent-design-review.md). No source or tests changed.

## Repository and execution conventions

This is `@juanbenjumea/pi-agy` 0.7.9: an ESM TypeScript Pi extension distributed as source through npm. Delegation tools launch the Antigravity CLI; provider turns use a persistent process and a localhost MCP bridge. There is no compiler-output build, lint script, or `just ci` gate. Use explicit `.js` relative imports in TypeScript, strict types, `node:test`, and `node:assert/strict`. Tests resolve sibling TypeScript through `tests/resolve-hook.mjs`; invoke the exact commands below, not a guessed test-runner filter.

The audited environment used Node 24.22.1. CI uses Node 22, while the manifest claims >=20.3.0; do not change runtime support in this task. Initial gates passed with installed dependencies: 305 tests, typecheck, package dry-run. Those installed versions differed from the lockfile, so do not describe them as clean-install proof.

Work on an operator-provided branch/worktree or an isolated branch named `advisor/007-design-truthful-end-to-end-bridge-diagnostics`. **Do not commit, push, publish, deploy, open issues/PRs, or merge without separate explicit authorization.** If authorized to commit, match Conventional Commit history (for example `23a0bf2 refactor: simplify agy extension guidance and modules`).

## Why this matters

The current doctor can report a bridge and tool count even when the active Pi catalog is not forwarded or fresh clients cannot initialize. Operators need a way to distinguish “configured,” “running,” and “proven functional.” Design a bounded, zero-inference diagnostic rather than claiming health from object existence.

**This plan produces a design report, not a shipped feature.** The executor must not edit source or tests. Ground a later implementation in the repaired bridge and avoid creating new behavior while known defects are still landing.

## Current state

- `extensions/lib/doctor.ts:39` describes diagnostics as inspecting state “without starting a model turn.” CLI/version, models, agents and quota are read-only probes; provider state is a snapshot.
- `extensions/lib/doctor.ts:303–330` builds provider status:
  ```ts
  parts.push(status.bridge ? `bridge ${status.bridge.toolCount} tools` : "bridge off");
  // ...
  return {
    name: "Provider",
    status: status.driver ? "ok" : "info",
    detail: parts.join(" · "),
  };
  ```
  Existence of a driver controls the status; this is not a functional bridge test.
- `extensions/lib/provider.ts:338–375` exposes non-creating `getProviderStatus`, whose bridge portion is only `{ toolCount }`. A bridged-tool count includes five builtins, so a positive count does not prove that a single active Pi tool was projected.
- `extensions/command-info.ts:14–37` calls `runAgyDoctor` after `ctx.waitForIdle()`, renders the report using `ctx.ui.notify`, and always clears the TUI status. `showBridge` separately reports configured/running status.
- `tests/live-smoke.ts:20–29` explicitly guarantees no inference:
  ```ts
  // Every probe is read-only. ... this script never submits an inference task.
  const [version, models, agents, usage] = await Promise.all([
    inspectAgyVersion(cwd, undefined, timeoutMs),
    inspectAgyModels(cwd, undefined, timeoutMs),
    inspectAgyAgents(cwd, undefined, timeoutMs),
    checkAgyUsage(cwd, undefined, timeoutMs),
  ]);
  ```
- Test conventions: `tests/doctor.test.ts` uses `withFakeAgy`, temporary project/agent directories, strict assertions, and checks exact named status/detail fields. MCP tests use authenticated SDK clients and close all handles in teardown.
- Reproduced motivating cases: a one-tool invocation reached the runner with zero tools; a second fresh MCP client received HTTP 400 from a previously initialized bridge. Verify that their repairs landed before designing health evidence.

## Scope

**Write only:** `plans/evidence/007-bridge-diagnostics-design.md` (create), own index row.
**Read/run:** the in-scope implementation/tests and local SDK docs; existing tests with fake CLI, no inference.
**Out of scope:** all source/test/manifest/config edits, changing default doctor semantics, adding an MCP diagnostic builtin, invoking arbitrary Pi tools, printing generated bridge tokens, editing global agent settings, real inference.
A subsequent implementation requires an approved new scope; mark this plan DONE when the design deliverable is complete, not when a feature exists.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Existing diagnostic tests | `node --import ./tests/resolve-hook.mjs --test tests/doctor.test.ts tests/provider-mcp.test.ts` | All pass |
| Provider boundary coverage | `node --import ./tests/resolve-hook.mjs --test tests/provider.test.ts` | All pass |
| Types | `npm run typecheck` | Exit 0 |
| Full gate | `npm test && npm run typecheck && npm run pack:check` | Exit 0, or pre-existing failure reported |
| No source edits | `git diff --exit-code -- extensions tests package.json package-lock.json .github` | Exit 0 against your starting implementation state |

## Steps

### Step 1: Define evidence levels and user-visible vocabulary

Create the design report with a status/evidence matrix covering: disabled configuration, never started, startup failure, live server, zero dynamic tools, active matching catalog, stale catalog, fresh-client initialize failure, parked-call handler unavailable, cancelled probe, and timeout.

Recommend separate passive status (default doctor; no new resources) and an explicit opt-in functional probe. A passive snapshot can say “running, not functionally tested”; it must not claim complete health. Distinguish builtins from dynamic Pi tools, and distinguish zero tools that the user intentionally selected from a forwarding mismatch.

**Verify:** `test -s plans/evidence/007-bridge-diagnostics-design.md` → exit 0; the report contains headings `## Evidence matrix` and `## Proposed interface` and one row per state above.

### Step 2: Design a non-disruptive zero-inference probe

Describe exact request/response sequence, ownership, deadline, cleanup and cancellation for a fake-backed automated integration check: current transcript tool extraction → projected catalog → fresh authenticated MCP client → tools/list → safe synthetic park → result delivery → reconnect. Use only a task-owned fake tool returning a fixed marker; never execute a user's real write-capable tool.

Recommend an **isolated test bridge** for functional diagnostics rather than injecting a synthetic call into a live provider turn. State clearly what this proves (local integration wiring) and does not prove (actual agy discovery or model selection). If an opt-in runtime check of an existing server is proposed, limit it to non-mutating discovery and explain session capacity/cleanup without consuming a live park or altering catalog/handler state.

Set a total suggested deadline (10 seconds) with cancellation propagated to every owned resource; report a timeout as inconclusive/failure, not healthy. The diagnostic must not permanently memoize test bridges or change global settings.

**Verify:** existing diagnostic tests → pass. Report contains `## Probe sequence`, `## Safety and cleanup`, and `## Proof boundaries`, with exact owner, request, expected response, and failure outcome for every step. Record test counts and no-inference constraints.

### Step 3: Specify the implementation contract and acceptance tests

In the report propose structural data fields and status text, exact production files that a later implementation would touch, backward-compatible default behavior, and named tests. Reuse `AgyDoctorCheck` status values (`ok | info | warn | error`); do not introduce an unrelated report format.

Define tests for empty allowed tool catalog, missing projected tool, deliberate bridge opt-out, failed startup, two fresh clients, active suspension without interference, expired deadline, immediate cancellation, and shutdown cleanup. Specify an assertion that no inference-capable CLI command was launched; the CLI fake should record argv rather than trusting comments.

Estimate implementation effort and identify open choices with recommended answers. Recommend one command/API spelling, not a menu with no default. Whether it is a new explicit doctor subcommand or a test-only gate must be a recorded decision; preserve current `/agy doctor` zero-inference promise.

**Verify:** provider boundary tests and typecheck → pass. Report contains `## Acceptance tests`, `## File-level implementation outline`, `## Decisions and open questions`, and `## Effort and trade-offs`.

### Step 4: Validate the design handoff

Run the full gate, record actual results/limits, and inspect the report for claims stronger than its evidence. Do not run `npm run test:live` unless specifically approved; the existing fake-backed commands are enough for this design. Link each observed status proposal to a code symbol and each promised guarantee to a proposed deterministic test.

**Verify:** full gate → exit 0 or unrelated failure reported; no-source-edit command and `git diff --check` → clean. Update the index as design-complete, with implementation unstarted.

## Test plan

No new tests are written. Run the existing diagnostic/provider suites, then specify executable acceptance-test cases for a later executor. Label synthetic evidence as synthetic. No arbitrary tool execution, model turn, or personal session data is needed.

## Done criteria

- [ ] A self-contained report includes all nine named sections and the required state matrix.
- [ ] It defines one recommended opt-in interface and preserves passive zero-inference defaults.
- [ ] Every probe step has an explicit ownership/deadline/cancellation/cleanup contract.
- [ ] Every promised behavior has a named proposed test and an expected assertion.
- [ ] Existing gates are recorded accurately; production files remain unchanged.
- [ ] Index status explicitly says design complete, implementation not started.

## STOP conditions

Stop if diagnosing the bridge requires real inference, inspecting private credentials, editing real configuration, executing a user's arbitrary active tool, or disrupting a live suspended turn. If the motivating fixes are absent, block this design rather than building a workaround around known-broken lifecycle code. Stop if a proposed status requires unavailable evidence; call it untested instead.

## Maintenance notes

Health checks age into false reassurance unless they test the same registration and transport path that production uses. Keep passive evidence and functional evidence separate, bound probes, and refresh tests when SDK sessions or catalog semantics change. Do not turn `/agy doctor` into an implicit inference task.

