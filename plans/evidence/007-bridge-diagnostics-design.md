# Bridge diagnostics — design complete; implementation unstarted

**Review: APPROVE.** [Independent read-only design review](007-008-independent-design-review.md). Proposed behavior below is not shipped or claimed as an executed probe.

The goal is to distinguish configuration, cached objects, a listening transport and a demonstrated local contract. This is a design, not a shipped diagnostic or permission to change doctor defaults.

## Evidence matrix

Use existing `AgyDoctorCheck { name, status: ok|info|warn|error, detail }`. Status always names its evidence scope; `ok` on a synthetic check never means a live agy/model connection is healthy.

| State | Required evidence; proposed status/detail | Current observability / proposed test |
|---|---|---|
| Deliberately disabled | Read `providerBridge === false`; info: `disabled by configuration` | `ensureProviderBridge` checks this; `diagnostic_disabled_is_noncreating` |
| Never started | Registry has no initialization attempt; info: `not started; not functionally tested` | Current public status loses this distinction; `diagnostic_never_started` |
| Startup failed | Recorded failed start, with bounded/redacted error code; warn | Current cache stores undefined for failure OR disabled; `diagnostic_start_failure` |
| Live listener | Owner reports listening and not stopping; info: `listening; functional path untested` | Cached handle alone is insufficient; `diagnostic_listener_is_not_health` |
| No dynamic tools, selection unknown | Builtin/dynamic provenance counted separately; info: `0 Pi tools; selection provenance unavailable` | Total count includes five builtins; `diagnostic_zero_tools_unknown` |
| Intentional empty catalog | Explicit invocation tools=[] projects to []; info: `empty catalog selected intentionally` |003 preserves this override; `diagnostic_empty_allowed` |
| Active matching catalog | Exact normalized expected definitions match fresh tools/list; ok: `synthetic catalog contract passed` | Not inferable from passive count/hash; `probe_catalog_matches` |
| Stale/missing catalog | Exact observed definitions differ from expected at the captured generation; warn | `probe_missing_or_stale_tool` |
| Fresh-client initialize failure | Authenticated SDK initialize fails on the owned bridge; error |004 repairs repeated initialization; `probe_two_fresh_clients` |
| Park handler unavailable | Synthetic dynamic call is refused with its error result; warn | `setParkHandler`/CallTool path; `probe_handler_missing` |
| Cancelled probe | Owner signal aborted; info: `cancelled; no conclusion` | `probe_immediate_cancel` |
| Probe deadline exceeded | Global deadline exhausted; warn: `timed out; inconclusive` | `probe_total_deadline` |
| Cleanup failed | Owned handles did not close within cleanup budget; error, never pass | `probe_shutdown_releases_resources` |

Do not infer disabled/startup-failed/never-started from `bridge === undefined`; do not infer a listener from an object in a registry. Dynamic expected counts come from actual `projectBridgeTools` output, not the raw transcript count: exclusions, duplicate names, sanitized-name collisions, the100-tool cap and schema normalization matter. Builtin provenance must be explicit, not guessed from a name prefix. Existing `bridgeToolsFingerprint` is a small change-detection hash, not a collision-proof catalog attestation; the probe compares full normalized definitions.

## Proposed interface

**Recommended functional interface: an explicit test-only `npm run test:bridge-contract` gate**, added only in a subsequent implementation. It runs a dedicated fake-backed integration test in an isolated Node test worker. Keep `/agy doctor` passive with respect to the provider: no new driver, bridge, catalog replacement, parked call or model turn. Existing CLI/version/model/agent/quota checks remain their existing zero-inference probes; do not silently add a synthetic model prompt.

For passive doctor, extend internal `ProviderStatus`/bridge-owned snapshot data with initialization outcome, listener state, builtin/dynamic counts and catalog-selection provenance. Render truthful `info`/`warn` text using the matrix. Do not call `ensureProviderBridge`, `getProviderDriver` or `resetProviderBridges` to discover status. Do not promise newly available evidence until the later implementation records it.

One proposed internal record is `{ kind: 'passive'|'synthetic', observedAt, generation, init: 'disabled'|'never'|'failed'|'listening'|'unknown', catalog: { requestedKnown, intentionalEmpty, builtinCount, dynamicCount, matches?: boolean }, result: 'untested'|'passed'|'failed'|'cancelled'|'timeout'|'cleanup-failed' }`. This is extension-owned data, not a new Pi event schema. A listener flag is only transport evidence. Synthetic results are invocation-local and never permanently memoized as live runtime health.

Prefer the already-verified public CommonJS `child_process.spawn`/`getSpawn` test boundary over a new production abstraction: the isolated worker can supply an **in-memory ChildProcess-shaped transport**, including stdin/stdout, while executing the real registered runtime, driver phase and bridge code. Simulated agy-shaped launch requests/protocol traffic are labeled simulation; they never delegate to a real OS executable. Record actual OS launches separately from these intercepted requests and install fail-closed fences for other process-launch APIs. A static runner returning a park directly is not a substitute for the driver/bridge contract.

A runtime probe of an existing server is **not recommended in this scope**: even initialize/tools/list consumes session capacity, and poll-result can consume a completed result. A later read-only-discovery option would need separate ownership/capacity policy and still could not prove tool execution or model discovery.

## Probe sequence

All of the following is a **proposed acceptance sequence**, not a probe implemented or run by this design. Use the same production registration/projection/bridge/phase adapters, not a second algorithm that merely resembles them.

| Step | Owner and operation | Expected observation | Failure outcome |
|---|---|---|---|
|0| Test-worker supervisor creates private agent/workspace roots; installs a spawn fence/recorder before loading runtime | No user settings/history/credentials consulted | Abort before allocating further resources |
|1| Test-only registration adapter invokes the real registered stream handler with synthetic transcript tools, including an excluded self-delegation tool; stream-options-present/absent variants | Production extraction/projector yields the exact safe fixture catalog; explicit[] remains empty | Catalog assertion fails; not a healthy result |
|2| Probe-owned bridge factory starts `startMcpBridge` outside live registries; `setTools` receives the captured projected definitions | Fresh private handle/listener, own config directory | Startup failed; cleanup owned partial resources |
|3| ClientA reads only that private config's authentication header in memory; initialize and tools/list using SDK client | Five builtin entries plus exact projected fixture entries/schema normalization | Auth/init/list error; no synthetic call |
|4| Keep the normal runtime's driver-linked park handler; the in-memory transport fixture's SDK client calls ONLY `diagnostic_marker` with fixed no-op arguments | Actual CallToolRequest allocates a park, production handler invokes the real driver phase path, provider emits matching shadow toolCall | Missing handler/park mismatch fails locally |
|5| Fixture executor returns fixed marker `bridge-contract-ok`; normal delivery adapter calls `completePark` with the captured call id | Pending MCP result has the marker and isError=false; resume settles its phase through the repaired waiter path | Wrong id/result, timeout or unsettled resume fails |
|6| ClientA terminates/closes its own session; clientB freshly initializes and lists tools on SAME owned bridge | Second initialize/list succeeds without recycling bridge | Fresh-client contract failure |
|7| Finally: abort pending fixture operations, fail own parks, close both clients, stop owned bridge, release sockets/timers and remove only owned temporary roots | No owned session/park/listener remains; no live registry changed | Cleanup failure overrides any pass |

The isolated worker's default runtime registries belong only to that fixture process, not the live Pi host. Its real lazy bridge startup may memoize there temporarily; close all those owned resources before worker exit. Prefer existing public spawn interception and private environment isolation before proposing a new factory seam. Current static runner injection bypasses default bridge startup; its success alone is not this combined contract. Registration extraction and MCP/park/delivery must share captured definitions and real adapters. Never execute an actual agy child to achieve apparent end-to-end coverage.

## Safety and cleanup

- Suggested total target:10 seconds measured with a monotonic clock, including setup and cleanup. Reserve8 seconds for operations and2 for cleanup; derive every wait from the same remaining budget. Pass one cancellation signal through fixture operations and SDK request adapters. Never restart a fresh10-second timer per step.
- A separate test-worker supervisor bounds an uncooperative worker at the total deadline; only that known Node worker may be terminated. No agy subprocess is allowed. OS cleanup of that worker closes its own sockets; do not signal arbitrary process groups or the live Pi host. Do not claim hard wall-clock guarantees under arbitrary OS stalls.
- Normal finally cleanup is still mandatory before supervisor fallback: fail owned parks, close/terminate SDK sessions, stop the bridge, clear every native timer, and settle tracked promises before releasing fixture ownership. A failed/expired cleanup produces `cleanup-failed`, not a silently successful race.
- Use task-private HOME/PI_CODING_AGENT_DIR so bridge startup's stale-directory sweep cannot inspect or remove real agent resources. Allocate unique config paths; verify cleanup paths belong to this fixture. Never edit global agy config.
- Never invoke a user's active tool, any builtin that reads real sessions/quota/skills, or `bridge_poll_result` on a live instance. The only invocation is the fixture-owned constant-marker tool. Builtins are listed, not called.
- Treat tokens/config headers as credentials: keep them in memory and redacted from snapshots, traces, failures and reports. Log bounded error codes and synthetic tool names, not request headers, config JSON or user arguments.
- Leave existing live suspended turns, catalogs, handler bindings, drivers, image staging and session capacity untouched. An acceptance test snapshots live-fixture state before/after the isolated probe and asserts equality.

## Proof boundaries

A passing proposed gate would prove local registration/catalog/SDK transport/synthetic park-delivery/reconnect wiring for the captured build and fixture. It would not prove actual agy discovery, CLI permission behavior, model selection, model tool-calling, arbitrary Pi tool correctness, user authorization or production network health. A passive doctor snapshot proves less: configuration and owner-observed state only. Keep these labels distinct.

The existing checks recorded below are regressions of repaired components, not evidence that this unimplemented combined diagnostic already exists. Decline stronger statuses when the supporting evidence is unavailable; use `untested` rather than inventing health.

## Acceptance tests

Proposed deterministic names/assertions for the later implementation:

1. `diagnostic_disabled_is_noncreating`: providerBridge=false; passive provider status creates no provider process or bridge, info/disabled. Existing default-doctor metadata CLI probes retain their existing allowlist; this is not a claim that the whole doctor command spawns no process.
2. `diagnostic_never_started` and `diagnostic_start_failure`: distinguish absent attempt from recorded failure; passive read leaves registries unchanged.
3. `diagnostic_listener_is_not_health`: a cached handle/dead driver cannot yield functional-ok; listener-only evidence says untested.
4. `diagnostic_empty_allowed`: explicit[] has zero dynamic tools and no mismatch warning; builtin count is separately5.
5. `probe_catalog_matches`: actual registered handler, with/without options, projects ordinary tools and excludes self-delegation; fresh list definitions deep-equal expected.
6. `probe_missing_or_stale_tool`: remove/change one fixture definition after capture; exact compare detects it even when counts match. A test-supplied equal fingerprint cannot substitute for equality.
7. `probe_handler_missing`: dynamic call with no handler returns the real refusal/error result and does not execute a tool.
8. `probe_two_fresh_clients`: initialize/list/terminateA then initialize/listB succeeds on one server; owned session slots are released.
9. `probe_synthetic_park_delivery`: call-id matching, exact fixed marker, non-error result and normal resume; no stale pre-tool commentary/result duplication.
10. `probe_does_not_touch_live_suspension`: separate live fixture's park, catalog, counters and callbacks are unchanged; synthetic result cannot complete its call id.
11. `probe_total_deadline`/`probe_immediate_cancel`: stall each stage or cancel before allocation; no false pass, no restarted budget, deterministic teardown.
12. `probe_shutdown_releases_resources`: cancel with pending request/park; clients/listener/timers close, private config directory is removed; injected cleanup failure yields error.
13. `probe_never_launches_inference`: for the separate opt-in functional gate, the actual-OS-launch recorder permits only the known Node test worker; no agy executable or unknown process may launch. Intercepted requests to the in-memory transport are recorded separately as simulation, with an exact expected argv/protocol allowlist and no native fallback. Assert both records, not comments. No prompt is sent to a real or external fake agy executable.

These are future tests, not added tests in this design.

## File-level implementation outline

- `extensions/lib/provider.ts`: non-creating truthful status fields; default registration/runtime path remains exercised. Add a narrow factory seam only if the existing public process boundary and isolated worker cannot provide the required control.
- `extensions/index.ts`: keep the actual registration/tool extraction path exercised; do not add a second extraction implementation.
- `extensions/lib/provider-tools.ts`: reuse existing projection and normalization unchanged; no security claim about its fingerprint.
- `extensions/lib/provider-mcp.ts`: expose owner-observed listener/init/count provenance as needed; preserve004 session/park lifecycle and existing auth limits.
- `extensions/lib/doctor.ts`: render evidence-qualified checks; `extensions/command-info.ts` retains passive doctor semantics/status cleanup.
- Future `tests/bridge-contract.test.ts` plus a narrow test-worker supervisor and explicit package script: own all probe resources. Extend `tests/doctor.test.ts` for passive states. No live-smoke/inference task is required.

This is an outline for separately scoped implementation, not authorization to modify these files now.

## Decisions and open questions

**Decided recommendation:** test-only opt-in contract gate; truthful passive doctor; synthetic marker tool; exact catalog equality; no live-park injection; one total deadline; no agy subprocess. Preserve existing Doctor result statuses and UI behavior.

Before implementation, specify the minimal injection seam and Node-worker supervisor API in that implementation plan. Whether to later add an explicit runtime discovery command is deferred, not a blocker for this report; it would prove a weaker/different property and needs its own scope. Recording startup-failure reason/listener state requires new owner data because current public snapshots cannot recover it retroactively.

## Effort and trade-offs

Estimated later implementation: M, roughly one focused day including the injection seam, supervisor, negative controls and review; an estimate, not a delivery commitment. A test gate is less convenient than a runtime health button but has a stronger non-interference boundary and no hidden user-tool execution. Do not build a generic observability platform, new MCP builtin or full agent health framework for this contract.

## Verification results and primary evidence

Design work changed no source/tests/config/dependencies. Reuse the exact accepted006 all-fixes baseline rather than rerunning completed gates: independent diagnostic/MCP/parser suites51/51, provider consumers40/40, driver19/19, full330/330, typecheck/package dry-run exit0. Logs and hashes: `plans/execution/006/independent-checks.json`, retained006 `.pi/reviewer/`. No test:live or inference command ran. These are existing component checks, not executions of the proposed probe.

Primary code inspected in the accepted006 tree: `doctor.ts::providerCheck` chooses ok merely from driver existence; `provider.ts::getProviderStatus` is non-creating but exposes only bridge toolCount; `ensureProviderBridge` merges disabled/failure as cached undefined; `provider-tools.ts::projectBridgeTools/bridgeToolsFingerprint`; `provider-mcp.ts::startMcpBridge`, per-session SDK creation, CallTool handler, `completePark`, `setParkHandler`, `stop`, `describe`; `command-info.ts::showDoctor`; `tests/live-smoke.ts` zero-inference contract. Source identities are pinned by the006 acceptance record; no claim is made about another installed runtime.
