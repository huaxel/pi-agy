# Plan 002 review — APPROVE

## Verdict and scope

**APPROVE in the retained isolated worktree; not applied to the original checkout.**
Executor: Pi / `openai-codex/gpt-5.6-luna`; one review revision.
Worktree: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-002-d6w16nm9/worktree`.
Changed source: `extensions/lib/spawn.ts`, `tests/regression.test.ts`.
[Reviewed patch](../patches/002-process-tree.patch).

The advisor read every diff hunk, checked the final heartbeat-based regressions and cleanup, and independently reran focused tests and the project gate. The production fix stops treating leader exit as evidence of process-group death, keeps the two-second/unref contract, and treats ESRCH as already gone. New descendants/parents self-expire and owned groups are cleaned in finally; fabricated group IDs were removed. No other source, manifests, lockfiles, workflows, staged changes or commits are included.

## Independent verification

Node 22.23.4 / npm 10.9.9, macOS, minimal environment and temporary HOME/agent directory:

| Check | Result | Evidence in worktree |
|---|---|---|
| Focused process-tree suite | exit 0; 6/6 pass | `.pi/reviewer/process-focused.log` / `.exit` |
| `npm test` | exit 0; 307/307 pass | `.pi/reviewer/tests.log` / `.exit` |
| `npm run typecheck` | exit 0 | `.pi/reviewer/typecheck.log` / `.exit` |
| `npm run pack:check` | exit 0; 42 entries | `.pi/reviewer/pack.log` / `.exit` |
| `git diff --check` | exit 0 | advisor inspection |
| Final-fixture RED against original production helper | executor recorded exit 1; 4 pass, 2 intended active-writer failures | `.pi/final-red-original-2.log` |

## Deviations and residual risks

The executor correctly stopped after its final full gate and focused rerun failed the existing preflight timing assertion. The advisor then compared baseline and fixed focused cases with system Bash and a Bash5-only shim: all four passed. This does not prove a shell-version cause or eliminate intermittency. The later independent full gate passed. All earlier failures remain recorded below; do not replace them with a claim that every attempt passed.

Fixture iteration exceeded the plan's two-failed-attempt STOP bound before being reported; acceptance is based on the corrected final fixtures, renewed RED proof, explicit deviation record and independent verification, not blind retries. No unrelated tests/timeouts were changed.

Remaining limits: grace-period execution, host exit before an unref'd timer, PID/process-group lifecycle, Windows direct-child fallback, and lock-release ordering are not newly guaranteed. Linux CI was not run. SDK/Zod advisory questions from 001 remain separate.

## Executor report (preserved verbatim)

The executor's STOPPED status below predates the advisor's passing independent gate; it is retained for provenance.

# Executor report — plan 002, reviewer revision round 1

- Status: STOPPED because the final full gate has one unrelated preflight timing failure; source/focused criteria otherwise pass.
- Worktree: `/private/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-002-d6w16nm9/worktree`
- Runtime: Node `22.23.4` (`/Users/juanbenjumea/.local/share/mise/installs/node/22.23.4/bin/node`), macOS POSIX.
- Source files changed: `extensions/lib/spawn.ts`, `tests/regression.test.ts` only.
- Install: `env -i PATH="/Users/juanbenjumea/.local/share/mise/installs/node/22.23.4/bin:/usr/bin:/bin" HOME="$PWD/.pi/home" PI_CODING_AGENT_DIR="$PWD/.pi" npm ci --ignore-scripts`; exit `0`.

## Final verification

- Final RED against original helper: saved the production edit to `.pi/spawn.fixed-final.ts`, restored only `extensions/lib/spawn.ts` with `git show HEAD:extensions/lib/spawn.ts > extensions/lib/spawn.ts`, then ran:
  `env -i PATH="/Users/juanbenjumea/.local/share/mise/installs/node/22.23.4/bin:/usr/bin:/bin" HOME="$PWD/.pi/home" PI_CODING_AGENT_DIR="$PWD/.pi" node --import ./tests/resolve-hook.mjs --test --test-name-pattern="process tree kill" tests/regression.test.ts`
  Exit `1`; 6 tests, 4 pass, 2 fail. Both intended regressions failed on active heartbeat/writer behavior: `descendant kept running after tree kill` and `descendant kept running after leader exit`. No setup/readiness failure. Raw log: `.pi/final-red-original-2.log`.
- Restoration was verified with `cmp` exit `0` before GREEN.
- Final GREEN focused command (same exact command) exit `0`; 6 tests, 6 pass, 0 fail. Raw log: `.pi/final-green-focused-2.log`.
- Full gate command actually executed (semicolon-separated, with collected exit codes):
  `env -i PATH="/Users/juanbenjumea/.local/share/mise/installs/node/22.23.4/bin:/usr/bin:/bin" HOME="$PWD/.pi/home" PI_CODING_AGENT_DIR="$PWD/.pi" bash -c 'npm test; a=$?; npm run typecheck; b=$?; npm run pack:check; c=$?; printf "codes test=%s typecheck=%s pack=%s\\n" "$a" "$b" "$c"; exit $((a||b||c))'`
  Overall exit `1`: test exit `1` with 307 tests, 306 pass, 1 fail; typecheck exit `0`; pack exit `0`. The sole failure was existing `preflight.test.ts` / `keeps the health retry inside the remaining timeout budget`, error `health retry exceeded the overall preflight timeout`. Raw log: `.pi/revise-full-gate.log`.
- Required focused rerun of that existing case:
  `env -i PATH="/Users/juanbenjumea/.local/share/mise/installs/node/22.23.4/bin:/usr/bin:/bin" HOME="$PWD/.pi/home" PI_CODING_AGENT_DIR="$PWD/.pi" node --import ./tests/resolve-hook.mjs --test --test-name-pattern="health retry" tests/preflight.test.ts`
  Exit `1`; 1 test, 0 pass, 1 fail, same timeout assertion. Raw log: `.pi/preflight-retry.log`.
- Scope: `git diff --check` exit `0`; `git diff --name-only` lists only `extensions/lib/spawn.ts` and `tests/regression.test.ts`; no commit or staging.

## Revision changes

- Both descendant and parent fixtures now self-expire after 30 seconds, later than each test's bounded failure deadline.
- The leader-already-exited case uses the actual exited `ChildProcess`, confirms readiness and a positive heartbeat before calling `killProcessTree(child)`, and asserts the heartbeat stops after escalation.
- The first case also uses a heartbeat to distinguish a surviving active writer from a non-running/zombie process-group entry; the existing ordinary group test invokes the helper after confirmed group absence for genuine already-gone no-throw coverage.
- Readiness, leader-exit, heartbeat, and close-listener timers are bounded/cleaned; known task-owned groups are SIGKILL-cleaned in `finally`.

## Fixture/debugging history and deviations

The initial RED used the earlier fixtures and failed both new cases. Intermediate GREEN attempts exposed, in order: leader-exit readiness races; an orphan/zombie group where `kill(-pid, 0)` remained observable despite no active writer; and a heartbeat sampled before its first write. The discriminating changes were parent readiness polling, a heartbeat invariant, bounded heartbeat readiness, and using the actual exited child. The final RED above was rerun against the final fixtures and original helper and reproduced both intended active-writer failures.

This debugging exceeded the plan's two-failed-attempt STOP bound; it is recorded rather than hidden. No unrelated tests or timeouts were changed. The full-gate failure was independently rerun once as required and remained the unrelated preflight timing failure, so execution stops here rather than broad-retrying.

Residual limits retained: synchronous API, two-second grace, timer `unref`, no claim of immediate tree death, lock-release ordering, Windows tree-kill support, or host-exit safety. No inference or credentials were used, and no task-owned processes remain pending to the best of the bounded cleanup checks.

