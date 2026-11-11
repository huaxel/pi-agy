# Provider state-machine fixes — 015

## Result

**Implemented, independently approved, integrated and verified; uncommitted.**
User requested “fix these” after the state-machine audit at **82af24b**.
No commit, push, publication, dependency installation or backup deletion occurred.

## What changed

- A driver turn retains exclusive ownership across park, resumed execution,
  and terminal delivery. A competing start cannot steal its child or output.
- Parked terminal success/error is retained for exactly one continuation.
  The existing suspension deadline still bounds abandonment. Obsolete signals
  and deadlines cannot kill the next turn; matching live children remain reusable.
- Parked cancellation, child close/error, explicit cancellation and shutdown
  converge on repeat-safe abandonment, including second and later parks.
- The default runner reserves ownership **before** changing bridge tools or
  mappings. Its operation token prevents orphaned parks being published later
  during asynchronous workspace-lock release.
- Terminal completion/abandonment discards owned bridge call IDs and unpolled
  escalation payloads. Ordinary polling stays available while an operation is live.
- Resume remains workspace-lock-free: no deadlock-prone lock reacquisition.

Source paths: `extensions/lib/provider-driver.ts`,
`extensions/lib/provider.ts`, `extensions/lib/provider-mcp.ts`.
Regression paths: `tests/provider-driver.test.ts`,
`tests/provider.test.ts`, `tests/provider-mcp.test.ts`.
Only these six source/test files changed.

## Review and reproducible checks

Native Herdr executor worked in retained
`/tmp/pi-agy-state-fixes-34DhuS/worktree`; a separate read-only reviewer required
one integration revision, then approved it. Advisor read the production/test
diffs, checked all six review hashes, and independently ran gates both isolated
and after original-checkout integration. All six integrated files are byte-identical
to the reviewed snapshot. HEAD remains 82af24b; staging is empty.

| Actual advisor gate | Isolated worktree | Original checkout |
|---|---|---|
| Focused driver/bridge/provider tests | 124/124 | 124/124 |
| Full npm test | 455/455 | 455/455 |
| npm run typecheck | pass | pass |
| npm run pack:check | pass | pass |
| Source diff whitespace check | pass | pass |

Runtime: Node26.13.0, npm11.20.0, macOS, existing installed dependencies.
Focused command:
`node --import ./tests/resolve-hook.mjs --test --test-timeout=15000 tests/provider-driver.test.ts tests/provider-mcp.test.ts tests/provider.test.ts`.

Final test commands prepended an executable that exits95 on unexpected real
agy execution and used isolated PI_CODING_AGENT_DIR values. Fake fixtures replace
spawn or prepend fake binaries; loopback bridge tests use real local MCP transport
without real inference. Raw logs are under
`/tmp/pi-agy-state-fixes-34DhuS/`: `advisor-focused.log`, `advisor-tests.log`,
`advisor-pack.json`, `integration-focused.log`, `integration-tests.log`,
`integration-pack.json`.

Original-driver probes reproduced lost ownership, missing retained outcomes and
missing orphan callbacks. Seven additional integration probes failed against the
pre-revision runner: catalog mutation, pre-publication orphaning and retained
escalations. The fixed tests verify those outcomes rather than polling away leaks.

## Evidence and execution deviations

- [First independent review](015-state-fixes-first-review.md): changes required.
- [Final independent review](015-state-fixes-independent-review.md): APPROVE,
  no residual correctness finding in reviewed scope.
- [Executor receipt](015-state-fixes-execution.md): regressions, exact commands,
  failures and limitations. Its “not integrated” and review-pending statements
  describe the worker's earlier checkpoint; this document is the current state.
- [Exact retained patch](../patches/015-provider-state-ownership.patch).

An early run of an existing lock test raced its own holder and **invoked real
agy**, which returned terminal authentication failure. This violated the intended
no-live boundary; successful inference or zero external activity is not claimed.
The fixture now awaits holder readiness and rejects any spawn. Subsequent final
runs used the fail-closed PATH guard. This was disclosed to the user.

Two intermediate executor test runs stalled in MCP client teardown and were
terminated using their confirmed owned process IDs. Tests now have short case
timeouts/watchdogs and explicit shutdown/client cleanup. Permission-denied test
and packaging attempts were retried with approved local access; failures are
retained in the execution report, not counted as passing gates.

## Remaining limits

No live-model success validation, Windows/minimum-Node matrix, fresh dependency
audit, formal model proof or managed-host update. Standalone bridge consumers
still own their ordinary polling lifecycle; no unrelated global TTL was added.
Broader provider architecture/typed Pi events remain outside this fix.
Worker/reviewer completed with no outstanding implementation questions.
