# Independent lifecycle review

Verdict: **changes required to satisfy the requested end-to-end lifecycle invariants**. The three driver fixes are coherent at the driver boundary, but three concrete caller/bridge interactions remain. These are residual integration defects, including pre-existing behavior; I found no separate new defect in the driver's retained-terminal timer cleanup itself.

Reviewed the working diff against `82af24bbb8f5bedd98e983c46d92d820547a6cf5` (also HEAD), including all four changed files, the complete driver, provider run/resume/stream/teardown callers, bridge park/escalation/session cleanup, locking, spawn primitives and test helpers. This was static read-only review: the traces below follow the actual control flow; they were not dynamically reproduced. No suite, inference, install, nested agent, source edit, commit, push or publication was performed. Only this requested report was written. Executor verification was left undisturbed.

## Findings

### P2 — Rejected fresh turns still overwrite the owner's bridge tool catalog

Changed-code anchor: `extensions/lib/provider-driver.ts:684-692`. Interacting caller: `extensions/lib/provider.ts:158-179`; tool dispatch: `extensions/lib/provider-mcp.ts:415-424,714-718`.

The new active-turn guard runs after the default runner has already called `bridge.setTools(request.bridgedTools)`. A resumed turn intentionally holds no directory lock, so a fresh default-runner invocation can acquire that lock, replace the shared bridge catalog, and then be rejected by the driver. Nothing restores the owner's catalog on rejection.

Concrete trace: A parks and resumes with a catalog containing `read`; B calls the default runner in the same directory with a catalog containing only `write`; B replaces the bridge catalog and receives “another agy turn owns this driver”; A subsequently calls its advertised `read` tool and receives “Unknown tool” at the bridge instead of parking for Pi. A same-name tool with a changed Pi mapping can likewise dispatch under B's mapping. The child/profile remains A's, while its bridge configuration is B's.

This is an incomplete ownership boundary, not a request to reacquire the workspace lock on resume. Catalog mutation before rejection already existed for a suspended owner; the new protection for resumed running also needs to cover this caller-side mutation. The added competing-turn tests (`tests/provider-driver.test.ts:475-496`) call the driver directly, so they bypass the offending mutation and cannot establish end-to-end preservation of ownership.

### P2 — Orphan callback can precede suspension publication and leave stale status/images behind

Changed-code anchor: `extensions/lib/provider-driver.ts:240-254`. Interacting caller: `extensions/lib/provider.ts:167-176,730-770`; asynchronous lock release: `extensions/lib/lock.ts:109-118`.

`notifyPark()` resolves the first phase and clears its waiter (`provider-driver.ts:217-220`). The provider does not publish its `suspendedByDir` record until it receives the runner's result and handles `end.kind === "parked"`. On the initial phase, `withDirLock` performs asynchronous owner-file read/removal before returning that parked result to the stream wrapper.

Concrete trace: a park is accepted; while the initial runner is releasing its lock, the child closes/errors or the signal aborts; `abandonTurn()` invokes the orphan hook once and releases the driver; the hook finds no suspension record yet and therefore cannot reclaim its image cleanups; the already-resolved parked result subsequently reaches the stream wrapper, which publishes a suspension and emits a shadow tool call for the dead turn. Its image cleanups are transferred to that stale record. No driver abandonment timer remains to collect this newly published state. Without another continuation/new user turn/session shutdown, the status and staged files persist indefinitely.

The callback being exactly once does not make publication safe: cleanup has already happened before the resource owner becomes visible. This publication gap is pre-existing, and remains a real limit on the requested first-park cleanup invariant. The new provider cleanup cases explicitly wait for stream end and assert that suspension exists before injecting failure (`tests/provider.test.ts:1314-1337`), excluding this ordering from coverage.

### P2 — Consuming an early-acked terminal leaves an escalation result without a bounded owner

Changed-code anchor: `extensions/lib/provider-driver.ts:280-286`. Interacting bridge/caller: `extensions/lib/provider.ts:211-224`; `extensions/lib/provider-mcp.ts:239-242,382-413,463-473,637-659`.

An early-acked park creates an escalation record. When agy then emits its terminal envelope while Pi is still running the tool, the driver retains that terminal. On continuation, `runner.resume()` first calls `completePark()`, which stores the full tool result in the escalation map and removes its park/owner. `continueTurn()` then consumes the retained terminal, releases active ownership and clears the abandonment deadline.

The terminal agy turn has no need to poll that tool result. The bridge deletes a completed escalation only when `bridge_poll_result` is called (`provider-mcp.ts:401,408`); there is no escalation TTL or capacity bound. Session cleanup iterates `parkOwners`, from which `completePark()` already removed this entry (`provider-mcp.ts:504-515,638-648`), and the session sweep does not collect the escalation map. The bridge is memoized across subsequent provider turns. Consequently the call ID and potentially large tool result remain retained until bridge teardown, accumulating across this scenario.

The same lack of collection also exists for other unpolled escalations; the newly supported terminal-consumption path makes the missing consumer explicit. The composed test masks this particular leak by manually polling *after* terminal consumption (`tests/provider-mcp.test.ts:802-813`), an action production terminal delivery does not perform. The 30-minute retained-terminal abandonment deadline does not bound a completed escalation after successful consumption.

## Driver invariant assessment

- **Fresh-turn admission:** `runTurn()` now rejects every existing active record before process/profile reuse or recycling. The first-phase queue still serializes ordinary unparked turns. The driver-level resumed overwrite is fixed; finding 1 covers the earlier caller mutation.
- **Terminal precedence and consumption:** success and failure received while suspended with no waiter are retained using `settled=true`, `suspended=false`, `pendingTerminal` present. `continueTurn()` checks that pending outcome before the ordinary settled/suspended checks and before cancellation, including when the child has subsequently closed. Consumption removes the pending terminal, clears `suspendedTimer`, releases `active` and arms idle reaping. No missing timer-clear statement was found on this path.
- **Bounded abandonment:** retained terminals keep the existing suspension deadline. Deadline, explicit cancellation and driver close can abandon a retained settled record. The deadline checks active-record identity before killing; a stale deadline cannot kill a successor.
- **Orphan callbacks:** ordinary first/subsequent suspended abort, child error/close, cancellation and shutdown now reach `abandonTurn()`. It clears the parked markers before calling the hook and clears active ownership on settlement. Repeated ordinary teardown therefore does not invoke the hook again. Child close/error after an authoritative terminal preserves that terminal unless abandonment is explicit. Finding 2 limits the provider resource consequence of the hook.
- **Signals and timers:** continuation removes the previous abort listener, installs its phase before checking an already-aborted current signal, reattaches cancellation when options omit a new signal, and avoids arming the resumed timeout after immediate settlement. `interruptTurn()` checks both settlement and active identity before killing. First/subsequent park timers are cleared on resume or abandonment. The optional-signal behavior is an intentional functional change from the baseline's removed-without-replacement listener; current code consistently uses the retained signal when none is supplied.
- **Reuse/profile/generation:** the admission guard precedes `ensureProcess()`, preserving the live profile and generation on rejected driver calls. Existing profile fingerprints, conversation binding and process-generation guards are otherwise unchanged. Close/error after a retained terminal does not erase its outcome. No additional introduced generation defect was established. The retained-success tests close the child before consumption, so they do not directly verify same-child reuse after retained consumption.
- **Workspace locking:** provider resume remains lock-free as requested. No lock reacquisition is proposed or needed to establish these findings.

## Test quality and no-live review

All new lifecycle cases use `withTimingFakeAgy`, which replaces `node:child_process.spawn` for the awaited fixture body; `getSpawn()` resolves that same CommonJS function. The fake supplies streams and no real PID, so these cases do not run real agy or send process-group signals. Existing shell-backed driver/provider helpers prepend their temporary fake `agy` executable. The revised lock test now awaits holder readiness, isolates the agent directory and installs a fake spawn that fails if reached.

The executor's `/tmp/pi-agy-state-fixes-34DhuS/no-live-bin/agy` was read, not executed: it is executable, has an actual newline after `#!/bin/sh` (verified bytewise), prints a guard diagnostic and exits 95. That is a valid fail-closed executable **when its directory precedes any live agy in the launched process PATH**. I did not launch a test command, so I do not attest to the executor's effective test-process PATH or any reported run result. The guard is external to the repository and is not automatically installed by `npm test`; an arbitrary unguarded invocation of the entire repository suite is not covered by this safety statement. `test:live` is a separate script and was not invoked.

The added tests have useful 100–3000 ms watchdogs, 20–1000 ms driver timeouts, a bounded 1-second stream-end poll and a bounded image-removal poll. Network calls also use the installed SDK's default 60-second request deadline (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:8,740`). However, several added parked/retained promises are awaited directly without a short independent watchdog and the `it` cases have no overall timeout. Once parked, the ordinary driver timeout is disabled; a lost phase/continuation regression can therefore wait for the 30-minute abandonment cap or leave a waiter pending instead of promptly producing the intended assertion. These are not uniformly bounded at the short regression-test budget. I did not execute them to test cancellation behavior.

Additional evidence limits:

- Retained-terminal consumption is not followed by a deterministic obsolete-deadline invocation or a live-child reuse assertion; the abandonment suite tests obsolete deadlines after *abandonment* instead. During final readback the executor added a clearTimeout spy and an assertion that pending terminals retain their deadline; I re-read that updated diff. It strengthens retention evidence without changing these consumption-coverage limits or the source findings.
- The provider shutdown case calls `getProviderDriver(dir)` after `closeProviderDrivers()` cleared the driver registry. Its final “no suspended turn” assertion is against a newly allocated driver (`provider.ts:247-256,377-384`), so that assertion alone cannot prove disposal of the original record. Other cleanup assertions still supply useful evidence.
- `Promise.allSettled(calls)` proves MCP requests settle, but does not verify that every orphan is delivered as an error; the composed ORPHAN case adds a diagnostic check. None of these observations invalidates the concrete state assertions that the tests do make.

## Verification and scope

Actually run: read-only status/diff/source inspection, byte inspection of the no-live executable, SHA-256 capture, and `git diff --check 82af24b` (exit 0). No focused tests, full gate, typecheck, packaging, live CLI, or runtime probes were run, as requested. No new security/credential exposure finding was established; no credentials were printed.

Observed working-tree source/test changes are exactly:

- `extensions/lib/provider-driver.ts`
- `tests/provider-driver.test.ts`
- `tests/provider-mcp.test.ts`
- `tests/provider.test.ts`

An untracked `node_modules` entry was present and preserved. This report is outside the worktree. No source fixes were made. There was no operational blocker to the read-only review; runtime verification belongs to the executor.

Reviewed file SHA-256 values (concurrent executor edits after this snapshot require re-review of the affected conclusions):

```text
de09582c35b2277556dc26eb1950e423a7e438eed42a27056b7c97ab9fb7f36c  extensions/lib/provider-driver.ts
4d853af1977114dd0c510a17789db2177df4b6f19b992a69399ab0c9066c6fa3  tests/provider-driver.test.ts
60e00ed8ab2bc8c45170e4ba80c9fdf156b0596d9ebbab8f9722b1a362afe100  tests/provider-mcp.test.ts
1347cb78b439cbd4cbc000639729a403c3824bcd7e4915d23bb4836a07bd8176  tests/provider.test.ts
```
