# Provider state-machine fixes — executor report, revision 1

Worktree: `/private/tmp/pi-agy-state-fixes-34DhuS/worktree` (the `/tmp` spelling resolves to this location).
Baseline and unchanged HEAD: `82af24bbb8f5bedd98e983c46d92d820547a6cf5`.
Status: implemented and locally verified; awaiting advisor review and independent verification. Not committed, integrated, pushed, published, or applied to the original checkout.

## Changed files

- `extensions/lib/provider-driver.ts`: reject fresh starts while any active record owns the driver; retain parked success/error envelopes for one continuation; preserve their abandonment deadline; centralize idempotent parked abandonment; guard obsolete deadlines/signals.
- `extensions/lib/provider.ts`: reserve a default-runner operation before bridge mutation; carry its validity token through parked phases and suspension publication; scope cancellation to the originating operation; release suspension/image ownership and all owned bridge call IDs on completion or abandonment. Expose the bridge's pending-result count through existing provider status.
- `extensions/lib/provider-mcp.ts`: add explicit, idempotent `discardParks(callIds)` ownership release and a `pendingResults` diagnostic count. Discard resolves any remaining HTTP waiter and clears both park/session ownership and escalation payloads.
- `tests/provider-driver.test.ts`: ownership, retained success/error, first/subsequent failure matrix, deadline retention/expiry, terminal-to-close, obsolete deadline/signal, and live-child reuse regressions; short watchdogs and overall case timeouts on the added cases.
- `tests/provider.test.ts`: default-runner catalog/mapping preservation, pre-publication orphan gap, unpolled escalation reclamation, ordinary polling, suspension/image/bridge failure matrix, and original-driver shutdown assertions. The existing directory-lock test now waits for holder readiness and installs a fake-spawn guard.
- `tests/provider-mcp.test.ts`: real authenticated bridge plus pid-free fake driver tests for early-acked success, terminal error, and orphan delivery; bounded waits and case timeouts.

No other source, plans, manifests, lockfiles, dependencies, or original-checkout files were edited. The pre-existing untracked `node_modules` symlink is preserved, targeting `/Users/juanbenjumea/projects/pi-extensions/pi-agy/node_modules`. No install was run. No nested agents were launched.

## Regression evidence

Logs are under `/tmp/pi-agy-state-fixes-34DhuS/`.

1. Before the initial production fix, new driver probes failed on the original implementation: fresh resumed-running starts were accepted or stole/recycled the child; pending terminal ownership probes expired; several parked abort/close/error/shutdown cases observed orphan-hook count `0` instead of `1`. `regression-driver.log` records 14 tests, 3 pass, 11 fail. An earlier long baseline probe was allowed to finish; it is not final gate evidence.
2. A combined original-driver probe with real isolated bridge transport recorded 31 new tests, 8 pass, 23 fail in `regression-composed-baseline.log`. The success continuation threw `agy provider driver has no suspended turn`; the error continuation lost the expected `FAILED` error and threw that same no-suspension error. Parked process failures left cleanup incomplete. Bounded watchdog failures are recorded in the log.
3. The strengthened deadline probes against the original driver failed 4/4 in `regression-deadline-final.log`. They explicitly inspect premature `clearTimeout`, rather than merely invoking a callback that production already cancelled.
4. Read `/tmp/pi-agy-state-fixes-34DhuS/independent-review.md` in full. All seven integration regressions failed before revision 1 (`revision1-regressions.log`). To substantiate the payload leak rather than only a missing diagnostic API, reran the pre-revision runner with the new bridge count exposed as observation only. `revision1-observed-regressions.log` records 0/7 pass: rejected B removed A's `read` catalog or changed its mapping; abort/close/error immediately after park acceptance published a shadow; both consumed terminal outcomes left `pendingResults` at `1` instead of `0`. No poll was used to clear that payload.
5. Revision 1's seven integration probes plus the two live-child reuse probes passed 9/9 (`revision1-focused.log`). The final affected suite additionally includes the ordinary live-polling witness.

Temporary baseline probes restored the fixed source automatically on exit; final HEAD and working diff were checked afterward.

## Lifecycle contract

- Ordinary unparked turns retain queue serialization. After a park releases the first phase, the same driver record owns parked, resumed-running, and terminal-awaiting-consumption states. A fresh turn cannot replace it or receive its output, including across profile changes.
- The default runner reserves an operation synchronously inside the workspace lock before bridge startup/catalog/handler mutation. Its ownership lasts through every park/resume and retained-terminal delivery. A rejected foreign start cannot change the owner's advertised tools or Pi mapping.
- Resume stays lock-free. It does not reacquire the workspace lock, preserving the documented deadlock boundary with lock-holding Pi tools.
- A parked terminal envelope finalizes process output, including authoritative final text, cap/truncation, conversation ID, activity, denied actions and error semantics. With no live phase waiter, the driver retains a typed success/error delivery. The next continuation consumes it exactly once, even if the child has since closed or the supplied continuation signal is already aborted. Child transport closure after an authoritative terminal does not orphan that result.
- Awaiting consumption keeps the original 30-minute suspension deadline, measured from the last park. Terminal arrival does not reset or clear it. Explicit cancel, driver shutdown, or expiry releases pending ownership and invokes orphan cleanup once. Consumption clears the deadline; stale callbacks/signals cannot kill a successor, and the still-live child can be reused when its conversation/profile matches.
- Running cancellation/timeout still produces flagged partial text when available and an error otherwise. A failure while parked has no phase waiter: abort, process close/error, cancel, deadline and shutdown abandon the operation, deliver a bridge error where possible, invalidate any unpublished parked result and reclaim suspension/image ownership. A later continuation reports no suspended turn (or closed driver). These abandonment errors are not retained for another continuation. A natural terminal failure received while parked is retained and delivered as its actual terminal error on continuation instead.
- A parked result carries its operation validity latch across asynchronous lock release. The stream checks it immediately before publishing suspension and shadow tool-call state. Abandonment before publication fails that check; its invocation-owned images are cleaned by the stream error path. Once published, the orphan hook can remove the matching suspension and staging. Stale cancellation is scoped by operation identity.
- The operation tracks its accepted bridge call IDs across repeated parks. Terminal completion/consumption, terminal error and abandonment explicitly discard those IDs and their unpolled escalation payloads. Polling remains available while the operation is live. No global polling TTL was introduced: standalone bridge consumers retain their ordinary poll behavior and can explicitly discard IDs when their own lifecycle ends.
- Shutdown regressions retain and assert against the original driver object, not a newly allocated registry entry.

## Final verification

Runtime: Node `v26.13.0`, npm `11.20.0`; existing verified dependency symlink, not a fresh install. No `just ci` exists in this repository; the requested npm gate was used.

Commands below ran from the isolated worktree. The guard is an executor-created executable that exits 95 on an unexpected real `agy` call; fake fixtures prepend their own fake binary or patch spawn. No `test:live` command was run.

```sh
PATH=/tmp/pi-agy-state-fixes-34DhuS/no-live-bin:$PATH node --import ./tests/resolve-hook.mjs --test --test-timeout=15000 tests/provider-driver.test.ts tests/provider-mcp.test.ts tests/provider.test.ts
# exit 0: 124 tests, 124 pass, 0 fail/cancelled/skipped
# focused-final.log

PATH=/tmp/pi-agy-state-fixes-34DhuS/no-live-bin:$PATH PI_CODING_AGENT_DIR=/tmp/pi-agy-state-fixes-34DhuS/full-test-agent npm test
# exit 0: 455 tests, 455 pass, 0 fail/cancelled/skipped
# revision1-npm-test.log; duration 32717.927791 ms

npm run typecheck
# exit 0; typecheck.log

npm run pack:check
# exit 0; pack-check.log; npm pack --dry-run --json, 44 package entries

git diff --check
# exit 0
```

Loopback tests and the package dry-run used approved execution outside the filesystem sandbox where required. Initial sandbox attempts actually failed (`bridge failed to start`; `EPERM` on the npm cache and a default lock directory); these were rerun with the required permissions. They are not reported as product failures or final passing checks.

## Deviations and evidence limits

- An early run of the existing directory-lock test raced its own holder and reached the installed real `agy` binary. It returned terminal `ERROR: authentication failed or timed out`. This violated the requested no-live-inference boundary: a real invocation occurred, and this report does not claim otherwise. The fixture now explicitly waits for lock ownership, isolates its agent directory and fails on any spawn. Subsequent focused/full runs used the executable PATH guard; final logs contain no guard-trigger diagnostic. No credentials or generated bridge secrets were printed.
- Two intermediate added-test runs stalled on MCP client promises after bridge shutdown. Those executor-owned processes were terminated, their sessions reaped, and their exact process IDs verified absent. Shutdown probes now close their client and use bounded waits. Inspection found zero remaining bridge-config directories matching those terminated process IDs. Before revision 1, process inspection confirmed there was no interrupted executor test run still active. All final runs completed sequentially, with no overlapping long test runs.
- The final full run is revision 1. Earlier 445/445 and 114/114 results belong to the pre-review implementation and are superseded by 455/455 and 124/124 above.
- The independent review was read-only and identified the three integration defects addressed here. The reviewer has not independently approved or verified revision 1. No additional reviewer agent was launched, per instruction. Advisor review/integration remains outstanding.
- Platform/runtime qualification is limited to this local Node 26/macOS execution and the installed dependency tree. No live inference, additional platform qualification, deployment, or original-checkout integration is claimed by the final gate.

Awaiting advisor review. Do not apply to the original checkout without explicit followup authorization.
