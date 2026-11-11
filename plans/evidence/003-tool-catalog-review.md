# Plan 003 review — historical block, superseded by approved003+009

**Current verdict: APPROVE with009.** The unchanged catalog proposal plus accepted timing fixtures independently passes314/314 twice, typecheck and packaging. [Final matching-tree review](009-timing-followup-review.md). The original blocked evidence below is preserved; its standalone tree is not the accepted final bundle.

## Historical blocked review

## Verdict

**BLOCK: functional catalog checks pass, but the final project gate is not green.**
Executor: Pi / `openai-codex/gpt-5.6-luna`; two review revisions used.
Retained worktree: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-003-30db2pyi/worktree`.
[Unapproved proposal patch](../patches/003-tool-catalog.patch).

Do not treat this as an approved/merged fix. The original checkout is unchanged. Plan 005 must not assume this predecessor has completed. A scoped timing-gate investigation or an explicit operator verification exception is needed before proceeding.

## Timing follow-up 009

The separately scoped [009 review](009-timing-verification-review.md) remains **BLOCKED**. Its final worker exited with a provider error; independent checks of its partial timing-only tree found typecheck failure, a silent cleanup-expiry defect, and 307/308 tests passing with an unchanged driver-case failure. Its final timing files do not match the retained integration copy. No historical combined pass supersedes this plan's blocked verdict; 005 must not proceed on an approval assumption.

## Source and test review

The advisor read the full diff. Production changes are limited to always forwarding extracted active tools in registration and selecting `options?.tools ?? deps.tools ?? []` in the runtime. Explicit empty catalogs override construction-time fallbacks; exclusions and permission policies are unchanged.

First review rejected missing registration integration and misleading per-turn/empty-override coverage. Second review required real workspace isolation, private assertion files, failure cleanup, bounded completion, faithful wire result status, and removing new any-based test signatures. The final proposal covers the same handler across turns, non-empty fallback versus explicit empty override, self-delegation exclusion, and actual registered-provider-to-authenticated-MCP discovery with and without stream options.

## Independent final verification

Node 22.23.4 / npm 10.9.9, macOS, minimal environment with temporary HOME and PI agent directory:

| Check | Result | Worktree evidence |
|---|---|---|
| Named runtime + registration catalog tests | exit 0; 5/5 pass | `.pi/reviewer/catalog-focused.log` / `.exit` |
| `npm test`, first reviewer attempt | exit 1; 309/310 pass | `.pi/reviewer/tests.log` / `.exit` |
| `npm test`, one final bounded attempt after earlier workers settled | exit 1; 309/310 pass | `.pi/reviewer/tests-settled-host.log` / `.exit` |
| `npm run typecheck` | exit 0 | `.pi/reviewer/typecheck.log` / `.exit` |
| `npm run pack:check` | exit 0; 42 entries | `.pi/reviewer/pack.log` / `.exit` |
| Scope/whitespace | only the three assigned files; no whitespace errors | advisor diff review |

The first reviewer failure was `tests/preflight.test.ts:94`, `keeps the health retry inside the remaining timeout budget` (about 15,059ms against a <15,000ms assertion). The final failure was `tests/execution.test.ts:1082`, `reports an observed id when timeout persistence fails`: execution reached its 1000ms deadline before the expected observed-conversation-id evidence was available. These clock/process-start-sensitive paths were not changed by this plan; nevertheless, the actual full-gate failures remain blockers under its done criteria. No assertion/timeouts were weakened and no third automatic attempt is planned.

The executor recorded a passing 310-test full run before its final fixture-only cleanup, but that is not substituted for a green final-tree gate. Its final STOP status is preserved below. Earlier RED proof with production hunks restored showed 4 expected failures among 5 new cases; test-first provenance remains in the raw logs.

## Remaining risks and next decision

- Intermittent existing timing tests need a bounded, separately scoped investigation; no root cause or reliable mitigation is claimed here.
- Final test fake/tooling assumptions still warrant CI validation; no Linux run or live inference was performed.
- SDK/Zod advisory exposure from 001 remains unresolved independently of this code change.
- Source changes are uncommitted and have not been combined with other proposal patches. No combined-tree gate has run.

## Executor report (preserved verbatim)

# Executor report

- Worktree: `/private/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-003-30db2pyi/worktree`
- Runtime: Node `v22.23.4`, npm `10.9.9`, minimal `env -i`, temporary HOME/PI_CODING_AGENT_DIR under `.pi/`.
- Install remains the prior successful `npm ci --ignore-scripts` (`.pi/npm-ci.log`).
- Source files changed remain only `extensions/index.ts`, `extensions/lib/provider.ts`, `tests/provider.test.ts`; this revision made no production edits.

## Completed test corrections

- Registration scenarios now execute after `process.chdir(workspace)` into the scenario's private mkdtemp workspace, with guaranteed cwd restoration.
- Assertion output is inside a private mkdtemp root and is removed in `finally`; no predictable pid/timestamp filename is used.
- Registered stream completion has a 3-second bounded guard. Driver cleanup runs in `finally`; cwd, PATH, agent-dir and helper resources restore on failure paths. The generated fake has a 5-second self-expiry (strictly beyond the test deadline) and also exits on stdin EOF.
- Fake wire result is now `{ event: "result", result: { status: "SUCCESS", response: "ok", conversation_id: "catalog-test" } }`. Tests assert completed `stopReason === "stop"` before reading tool names.
- Fake registration signatures use narrow structural types; transcript messages use a typed local extension of `ProviderTranscriptMessage`, with no `any` signatures or unknown transcript cast. TypeBox schemas and active/removed/self-delegation assertions remain.
- Existing runtime per-turn, explicit-empty, fallback, self-exclusion, and RED evidence were preserved.

## Verification

- Registration focused: `node --import ./tests/resolve-hook.mjs --test --test-name-pattern="provider registration active tool catalog" tests/provider.test.ts` — exit 0, 2/2 pass (`.pi/registration-final.log`).
- Provider focused: `node --import ./tests/resolve-hook.mjs --test tests/provider.test.ts` — exit 0, 36/36 pass (`.pi/provider-focused-final.log`).
- Typecheck: `npm run typecheck` — exit 0 (`.pi/typecheck-final2.log`).
- Pack: `npm run pack:check` — exit 0 (`.pi/pack-final.log`).
- Final full gate: `npm test && npm run typecheck && npm run pack:check` — exit 1; npm test had 310 tests, 309 pass, 1 fail in the unrelated existing `preflight cold-start retry` timing assertion (`health retry exceeded the overall preflight timeout`); `&&` therefore did not execute the later commands in this invocation (`.pi/full-gate-final.log`).
- Prior successful full gate remains preserved in `.pi/full-gate-round2.log` (310/310 plus typecheck and pack), while the earlier timing failure and passing isolated rerun remain `.pi/full-gate.log` and `.pi/preflight-rerun.log`.
- Scope audit: `git diff --check` exit 0; `git diff --name-only` lists only the three assigned files. No commits, staging, dependency changes, production edits in this revision, or pending processes.

