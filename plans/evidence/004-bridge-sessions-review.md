# Plan 004 review — APPROVE

## Verdict and ownership

**APPROVE in the retained isolated worktree; not applied to the original checkout.**
Executor: Pi / `openai-codex/gpt-5.6-luna`; two review revisions.
Worktree: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-004-sab5hisb/worktree`.
Changed source: `extensions/lib/provider-mcp.ts`, `tests/provider-mcp.test.ts`.
[Reviewed patch](../patches/004-bridge-sessions.patch).
[Reproducible independent lifecycle probes](004-review-probes.mjs).

The advisor read every diff hunk and independently checked the final source, security boundaries, session ownership, park settlement, focused tests, consumers and full project gate. No other source/config/manifest/lockfile changes, staging, commits, merges or publication are included.

## Important findings resolved during review

1. Initial singleton repair failed to release capacity on explicit DELETE. Independent raw HTTP produced initialize200 → DELETE200 → next initialize503. Stable session identity and the SDK session-close callback now release it.
2. Idle expiry killed an accepted escalated park. Independent raw HTTP produced STILL RUNNING then same-session ping404 before tool completion. Session-owned park liveness now survives the early HTTP response until actual settlement.
3. Synchronous completion inside an accepted park callback created a phantom live park and spurious escalation. Independent raw HTTP returned the final result but its idle session never expired. Ownership now registers before the callback; synchronous settlement prevents arming escalation.

The final code uses one MCP server/transport per session, SDK initialization/close callbacks, pending reservations, a stopping guard, bounded session defaults, and idempotent owner cleanup. Token/Host validation, request byte bounds, workspace confinement and Pi approval routing remain unchanged.

## Independent verification

Node 22.23.4 / npm 10.9.9, macOS, minimal environment and task-local HOME/agent directory:

| Check | Result | Worktree evidence |
|---|---|---|
| Independent raw lifecycle probes | exit 0; all scenarios pass | `.pi/reviewer/bridge-probes.log` / `.exit` |
| MCP regression suite | exit 0; 21/21 pass | `.pi/reviewer/mcp-focused.log` / `.exit` |
| Provider/driver consumers | exit 0; 46/46 pass | `.pi/reviewer/consumers.log` / `.exit` |
| `npm test` | exit 0; 311/311 pass | `.pi/reviewer/tests.log` / `.exit` |
| `npm run typecheck` | exit 0 | `.pi/reviewer/typecheck.log` / `.exit` |
| `npm run pack:check` | exit 0; 42 entries | `.pi/reviewer/pack.log` / `.exit` |
| Scope/whitespace | only the two assigned files; no whitespace errors | advisor diff inspection |

Probe scenarios: distinct simultaneous sessions, capacity rejection, immediate DELETE slot reuse, catalog changes and completed park after reconnect, raw early-ACK park surviving idle expiry, final result polling, completed idle reclamation, synchronous completion, declined/throwing callbacks releasing ownership, and bounded shutdown of two sessions with a pending synthetic park. No real Pi tools or inference were executed; no generated token value was printed.

To rerun from the retained worktree, create its ignored `.pi/reviewer/home` and `.pi/reviewer/agent`, select Node22 in PATH, and use a minimal environment with HOME/PI_CODING_AGENT_DIR pointing there:

```sh
node --import ./tests/resolve-hook.mjs \
  /Users/juanbenjumea/projects/pi-extensions/pi-agy/plans/evidence/004-review-probes.mjs \
  "$PWD"
```

The probe script refuses default/global HOME or agent paths.

## Deviations and remaining risks

The executor's initial claims were not sufficient for approval; the three lifecycle failures above were reproduced and repaired through review. Earlier full-gate timeouts/timing failures remain in its report/logs. Final acceptance uses the final-tree independent 311-test pass and direct probes, not a focused retry alone.

Some requested shutdown/decline/throw/final-polling edge cases are exercised by the retained independent probe script rather than additional canonical `tests/provider-mcp.test.ts` cases. This verification placement deviation is accepted on the reproducible evidence above, but those cases are **not part of npm test**; promote them into the canonical suite before broader bridge refactoring. No production test-only API was added.

The normal-cap/TTL options are internal/test-facing; public configuration exposure would need stricter integer-option contracts. No Linux CI, live agy inference, real user approval flow, dependency update, or combined-tree integration check was performed. SDK/Zod advisory questions from 001 remain separate. Source changes are uncommitted and isolated; merging remains the operator's decision.

## Executor report (preserved verbatim)

# Executor report — plan004 revise round2 final

Worktree: `/private/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-004-sab5hisb/worktree`
Runtime: Node 22.23.4 (`/Users/juanbenjumea/.local/share/mise/installs/node/22.23.4/bin/node`), minimal `env -i`, HOME/PI_CODING_AGENT_DIR under `.pi`.
Tracked files changed only: `extensions/lib/provider-mcp.ts`, `tests/provider-mcp.test.ts`; no commit/staging.

## RED/GREEN
- RED synchronous-completion leak: focused MCP command exited 1; 18 pass and the new synchronous-completion test failed with authenticated fresh initialization status 503 after synchronous `completePark` + accepted callback (`.pi/logs/round2-red.log`).
- GREEN focused: same command exited 0; 21 pass (`.pi/logs/round2-focused-final3.log`).

## Fixes and coverage
- Park ownership is registered before callback invocation. Synchronous completion is detected before escalation is armed. Decline, throw, complete, escalation, fail-all, session-close, and teardown release ownership idempotently.
- Stable typed session records are used; pending reservations survive handshake and are transferred through SDK `onsessioninitialized`. SDK `onsessionclosed` and transport close dispose sessions. Stop blocks allocation and closes pending pairs.
- Tests cover explicit raw DELETE slot reuse, malformed/unknown nonallocation, concurrent cap-1 initialization, synchronous completion and idle reuse, raw HTTP escalated park surviving idle TTL with ping/poll/completion, and prior reconnect/cap/teardown behaviors.

## Verification
- Focused: `node --import ./tests/resolve-hook.mjs --test tests/provider-mcp.test.ts`, exit 0; 21 pass.
- Consumers: `node --import ./tests/resolve-hook.mjs --test tests/provider.test.ts tests/provider-driver.test.ts`, exit 0; 46 pass (`.pi/logs/round2-consumers-final.log`).
- Typecheck: `npm run typecheck`, exit 0 (`.pi/logs/round2-typecheck-final.log`).
- Pack: `npm run pack:check`, exit 0 (`.pi/logs/round2-pack-final.log`).
- Full gate: `npm test`, exit 0; 311 pass (`.pi/logs/round2-full-final.log`).
- Scope: `git diff --check` exit 0; `git diff --name-only` lists only the two assigned tracked files; `.pi` evidence ignored.

Prior timeout/preflight history remains in earlier report logs. No pending task-owned processes/questions.

