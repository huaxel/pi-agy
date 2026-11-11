# Plan 003: Forward active Pi tools into every provider turn

> **Executor instructions:** Read this entire plan, follow the steps in order, and run each verification. Do not improvise around STOP conditions. Update only your status row in `plans/README.md` when complete, unless the reviewer owns the index.
>
> **Drift check (first):** `git diff --stat 1bf9d29..HEAD -- extensions/index.ts extensions/lib/provider.ts tests/provider.test.ts`. Also run `git status --short` and inspect uncommitted changes. Compare the excerpts below with live code. Any material mismatch requires an updated plan before editing; preserve other workers' changes.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW
- **Depends on:** plans/001-establish-the-locked-dependency-verification-baseline.md — passing baseline or operator-approved exception
- **Category:** bug / tests
- **Planned at:** commit `1bf9d29`, 2026-11-11
- **Execution review:** APPROVE with plan009's accepted verification fixtures; exact003+009 independently passes314/314 twice, typecheck and packaging. [Final review](evidence/009-timing-followup-review.md); [historical blocked review](evidence/003-tool-catalog-review.md). Source remains isolated and uncommitted.

## Repository and execution conventions

This is `@juanbenjumea/pi-agy` 0.7.9: an ESM TypeScript Pi extension distributed as source through npm. Delegation tools launch the Antigravity CLI; provider turns use a persistent process and a localhost MCP bridge. There is no compiler-output build, lint script, or `just ci` gate. Use explicit `.js` relative imports in TypeScript, strict types, `node:test`, and `node:assert/strict`. Tests resolve sibling TypeScript through `tests/resolve-hook.mjs`; invoke the exact commands below, not a guessed test-runner filter.

The audited environment used Node 24.22.1. CI uses Node 22, while the manifest claims >=20.3.0; do not change runtime support in this task. Initial gates passed with installed dependencies: 305 tests, typecheck, package dry-run. Those installed versions differed from the lockfile, so do not describe them as clean-install proof.

Work on an operator-provided branch/worktree or an isolated branch named `advisor/003-forward-active-pi-tools-into-every-provider-turn`. **Do not commit, push, publish, deploy, open issues/PRs, or merge without separate explicit authorization.** If authorized to commit, match Conventional Commit history (for example `23a0bf2 refactor: simplify agy extension guidance and modules`).

## Why this matters

The package advertises that agy provider turns can call active Pi tools through Pi's normal permissions/approval path. The registered provider passes those tools through turn options, but the runtime reads only construction-time dependencies, which the registration never populates. A focused fake-runner probe supplied one active tool and observed an empty `bridgedTools` array.

## Current state

- `extensions/index.ts:87–95` calls the runtime like this:
  ```ts
  context.messages as unknown as ProviderTranscriptMessage[],
  options
    ? {
        signal: options.signal,
        reasoning: options.reasoning,
        tools: getCurrentTools(context.messages) as unknown as ProviderToolSource[],
      }
    : undefined,
  ```
  Tool extraction also incorrectly depends on optional stream options being supplied.
- `extensions/lib/provider.ts:721–731` constructs the request with:
  ```ts
  skipPermissions: deps.skipPermissions ?? true,
  bridgedTools: projectBridgeTools(deps.tools ?? []),
  callbacks,
  ```
- `AgyStreamSimpleOptions.tools` and `AgyProviderStreamDeps.tools` already exist. `projectBridgeTools` in `extensions/lib/provider-tools.ts` sanitizes names, schemas, collisions, and excludes agy self-delegation; preserve it unchanged.
- Existing round-trip coverage at `tests/provider.test.ts:316–355` supplies `tools` in `deps`, not turn options, and returns a fake park regardless of the request. It therefore misses registration wiring.
- Existing helpers in the same test file:
  ```ts
  function makeStaticRunner(
    run: (request: ProviderTurnRequest) => Promise<ProviderTurnResult>,
  ): ProviderTurnRunner {
    return {
      run: async (request) => ({ kind: "done" as const, result: await run(request) }),
      resume: async () => { throw new Error("unexpected resume without suspension"); },
      cancel: () => {},
    };
  }
  ```
  Match `withIsolatedAgentDir`, recording factories, strict assertions, and `afterEach(closeProviderDrivers)`. Keep any fake CLI model-discovery work isolated with `withFakeAgy`.
- Documentation constraint: default bridge behavior is additive; self-delegation remains excluded; normal Pi tool execution/approval must remain the mutation path.

## Scope

**Modify only:** `extensions/index.ts`, `extensions/lib/provider.ts`, `tests/provider.test.ts`, own index row.
**Out of scope:** schemas or sanitization in `provider-tools.ts`, direct execution of Pi tools in MCP handlers, permission defaults, provider sessions, transport lifecycle, dependencies, delegation tools, docs.
No refactor of unrelated provider formatting.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import ./tests/resolve-hook.mjs --test tests/provider.test.ts` | All pass |
| Types | `npm run typecheck` | Exit 0 |
| Full gate | `npm test && npm run typecheck && npm run pack:check` | Exit 0 |
| Scope | `git diff --check; git diff --name-only; git status --short` | Scoped edits only |

## Steps

### Step 1: Test the runtime catalog boundary

Use `makeStaticRunner` to capture `request.bridgedTools`; do not fabricate a park without checking the received catalog. Add cases with:
1. Tools supplied only through invocation options.
2. Different invocation catalogs on consecutive fresh turns.
3. `options.tools: []` overriding a non-empty `deps.tools`.
4. Omitted invocation tools retaining `deps.tools` as the existing test injection fallback.
5. An agy self-delegation tool excluded while an ordinary tool survives.

Name the new suite `provider active tool catalog`. Await stream completion with a bounded helper instead of adding arbitrary sleeps.

**Verify:** `node --import ./tests/resolve-hook.mjs --test --test-name-pattern="provider active tool catalog" tests/provider.test.ts` → cases 1–3 fail against old code; excluded-name/fallback behavior remains explicit.

### Step 2: Consume per-turn tools and always extract them in registration

Change the runtime to project `options?.tools ?? deps.tools ?? []`; an explicitly empty array must not fall back. In `index.ts`, always pass an options object containing `tools: getCurrentTools(context.messages)`, with optional chaining on `signal` and `reasoning`. The existence of `SimpleStreamOptions` must not determine whether tools are available.

Keep current structural boundary casts; do not widen any internal interface to `any` or duplicate tool projection logic.

**Verify:** runtime focused suite → all cases pass; `npm run typecheck` → exit 0.

### Step 3: Exercise the registered provider path

Extend the existing registration tests in `tests/provider.test.ts` (the fake `ExtensionAPI.registerProvider` near line 685) with an integration case that constructs a supported Pi transcript carrying active tools. The audited peer's `getCurrentTools` replays `system.toolsRemoved` and `system.toolsAdded` by tool name. Use a fixture shaped like `{ role: "system", content: "test", timestamp: 0, toolsAdded: [tool] }`, followed by a user message; use TypeBox `Type.Object(...)` for the tool's parameters and the peer's actual transcript types. A subsequent system message with `toolsRemoved: [{ name: tool.name }]` represents removal. Confirm this shape against the locked peer before using it.

Invoke the captured registered `streamSimple` once without options and once with options. Use a test-local fake persistent agy process to inspect its advertised bridge via authenticated MCP `tools/list`; never run a real inference turn. The fake should handle background `models` discovery, read one stream-json user line for a provider turn, find the bridge's `.agents/mcp_config.json` under the supplied `--add-dir` arguments, initialize an SDK client, and write only the listed tool names to a temporary assertion file before returning a successful result envelope. Resolve SDK module URLs with `import.meta.resolve` in the test and embed those absolute URLs in the generated Node fake, rather than assuming its temporary cwd can resolve packages. Close the fake MCP client and child in teardown. Run each registration scenario in a distinct temporary workspace, calling `closeProviderDrivers()` between scenarios: this prevents the separately planned MCP reconnect bug from blocking this catalog regression. Never record the header/token. Assert the ordinary active tool is present in both cases and a removed tool is not advertised. Keep this helper local to the test file; no production injection seam is required.

If the supported transcript helper or fake-process seam is different from expected, STOP to refine the plan rather than patching global package internals or exporting a production test-only API. A direct runtime unit test alone is insufficient to cover the original registration defect.

**Verify:** focused command → all tests pass, including named registration cases; no real agy inference is launched.

### Step 4: Run the project gate and inspect changes

**Verify:** full gate → exit 0; scope commands → only approved files plus index. Update your row and report exact test counts.

## Test plan

Follow the test file's recording factory/static-runner convention and existing fake registration test, not a new framework. Check actual `bridgedTools` definitions, not just a successful fake response. Preserve existing sanitization and tool park/resume tests.

## Done criteria

- [ ] Per-invocation tools override construction-time tools; explicit empty invocation catalogs remain empty.
- [ ] Omitting stream options does not omit tool extraction.
- [ ] Runtime and registered-provider tests cover both paths without inference.
- [ ] Full project gate exits 0; scope and whitespace checks are clean.
- [ ] No permission policy or self-delegation exclusion changes.

## STOP conditions

Stop if `getCurrentTools` no longer reads the documented transcript API, a material drift changes registration, end-to-end verification requires a live model turn or personal MCP config, or a new testing seam needs out-of-scope API changes. Stop after two reasonable failed attempts at a gate.

## Maintenance notes

Tool changes must continue to feed `bridgeToolsFingerprint`, which triggers driver recycling. Keep coverage for explicit empty catalogs: falling back to stale tools can expose capabilities the caller intentionally removed. Coordinate with terminal-response work touching `provider.ts`; do not execute those edits concurrently.

### Learned execution boundary

The isolated proposal now passes five new functional boundary tests, typecheck and packaging, but its final independently repeated full suite failed twice (309/310): `tests/preflight.test.ts:94` exceeded its wall-clock bound, then `tests/execution.test.ts:1082` hit its deadline before capturing the expected conversation id. No timing-test edits or verification exception are authorized by this plan. Two review revisions are exhausted; do not blindly retry or weaken assertions. Preserve the proposal and resolve verification through a separately scoped investigation or explicit operator exception before executing dependent plan 005. A prior passing full run on an earlier fixture version is not a final-tree pass.

