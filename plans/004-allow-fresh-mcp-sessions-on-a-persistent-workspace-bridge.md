# Plan 004: Allow fresh MCP sessions on a persistent workspace bridge

> **Executor instructions:** Read this entire plan, follow the steps in order, and run each verification. Do not improvise around STOP conditions. Update only your status row in `plans/README.md` when complete, unless the reviewer owns the index.
>
> **Drift check (first):** `git diff --stat 1bf9d29..HEAD -- extensions/lib/provider-mcp.ts tests/provider-mcp.test.ts`. Also run `git status --short` and inspect uncommitted changes. Compare the excerpts below with live code. Any material mismatch requires an updated plan before editing; preserve other workers' changes.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (transport and teardown lifecycle)
- **Depends on:** plans/001-establish-the-locked-dependency-verification-baseline.md — passing locked baseline or operator-approved exception
- **Category:** bug
- **Planned at:** commit `1bf9d29`, 2026-11-11

## Repository and execution conventions

This is `@juanbenjumea/pi-agy` 0.7.9: an ESM TypeScript Pi extension distributed as source through npm. Delegation tools launch the Antigravity CLI; provider turns use a persistent process and a localhost MCP bridge. There is no compiler-output build, lint script, or `just ci` gate. Use explicit `.js` relative imports in TypeScript, strict types, `node:test`, and `node:assert/strict`. Tests resolve sibling TypeScript through `tests/resolve-hook.mjs`; invoke the exact commands below, not a guessed test-runner filter.

The audited environment used Node 24.22.1. CI uses Node 22, while the manifest claims >=20.3.0; do not change runtime support in this task. Initial gates passed with installed dependencies: 305 tests, typecheck, package dry-run. Those installed versions differed from the lockfile, so do not describe them as clean-install proof.

Work on an operator-provided branch/worktree or an isolated branch named `advisor/004-allow-fresh-mcp-sessions-on-a-persistent-workspace-bridge`. **Do not commit, push, publish, deploy, open issues/PRs, or merge without separate explicit authorization.** If authorized to commit, match Conventional Commit history (for example `23a0bf2 refactor: simplify agy extension guidance and modules`).

## Why this matters

Provider drivers recycle on model, effort, conversation, catalog, or permission changes and after idle reaping. Their workspace bridge is memoized separately and outlives those processes. A new MCP client therefore needs to initialize against an already-used server URL. The audit reproduced initialization status 200 followed by status 400, `Invalid Request: Server already initialized`, using two fresh clients and the same bridge.

## Current state

- `extensions/lib/provider-mcp.ts:470–475` incorrectly assumes one stateful transport can serve fresh sessions:
  ```ts
  // Stateful: one transport serves many agy sessions, routed by the
  // session id header. The default (no generator) is stateless and rejects
  // any second request on the same transport.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  ```
- All HTTP requests route to that transport. The low-level `McpServer` imported from `@modelcontextprotocol/sdk/server/index.js` connects once in startup. Its handlers capture bridge-wide catalogs, parks, escalations, and cache.
- `extensions/lib/provider.ts:266–279`:
  ```ts
  if (providerBridges.has(key)) return providerBridges.get(key);
  // ...
  providerBridges.set(key, handle);
  ```
  Recycling the child does not create a new bridge.
- SDK stateful transports represent one initialized session, not a session router. The audit's installed SDK 1.32.2 rejects reinitialization; inspect the exact version established by the dependency-baseline investigation.
- Existing test helper convention (`tests/provider-mcp.test.ts:50–58`):
  ```ts
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { [BRIDGE_TOKEN_HEADER]: token } },
  });
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  ```
  Existing tests create only one client per bridge. `afterEach` stops task-owned bridges, and `withIsolatedAgentDir` protects real user config.

## Scope

**Modify only:** `extensions/lib/provider-mcp.ts`, `tests/provider-mcp.test.ts`, own index row.
**Read:** provider memoization and SDK session examples/types.
**Out of scope:** driver process recycling, provider permission defaults, tool schema projection, auth changes, new dependencies, user/global MCP configs, delegation history.
Preserve the `McpBridgeHandle` public shape and the single stable bridge config URL/token.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import ./tests/resolve-hook.mjs --test tests/provider-mcp.test.ts` | All pass |
| Consumers | `node --import ./tests/resolve-hook.mjs --test tests/provider.test.ts tests/provider-driver.test.ts` | All pass |
| Full gate | `npm test && npm run typecheck && npm run pack:check` | Exit 0 |
| Scope | `git diff --check; git diff --name-only; git status --short` | Scoped edits only |

## Steps

### Step 1: Add the reconnect regression

Add a named test `accepts fresh clients after an earlier MCP initialization`. Start one isolated bridge, initialize client A, list tools, close A, then initialize client B using a new client/transport and no inherited session id. B must list tools and call the harmless sessions-list builtin. Neither client may start agy inference. Add a simultaneous A/B initialization case on the same workspace bridge; both need distinct session IDs.

**Verify:** focused command → the new second-client assertion fails before the fix with the initialization error; existing tests remain unchanged.

### Step 2: Introduce explicit per-session server/transport ownership

Read SDK stateful-server examples for the exact installed version. Use a bridge-owned session registry keyed by `mcp-session-id`, with **one low-level MCP server and one stateful transport per initialized client session**. Do not reconnect one low-level server to multiple transports. Factor handler registration into a local factory so all session servers share the bridge-owned catalog/cache/park/escalation state and unchanged builtin behavior.

Route initialization with no session header to a fresh pair. Route subsequent authenticated requests to the matching pair. Reject unknown session IDs and invalid initialization headers without creating a session. Use SDK callbacks for initialization/close according to that version. Ensure failed initialization cleans up an unregistered pair.

Perform existing URL/method/token/Host validation and byte-bounded JSON body reading **before** session allocation/SDK processing. A malformed or unauthenticated request must not allocate a session. Keep host binding on 127.0.0.1 and restrictive atomic config creation.

**Verify:** focused command → sequential and simultaneous fresh clients work; existing token/Host/oversize tests still pass. `npm run typecheck` → exit 0.

### Step 3: Bound and dispose session resources

Set an explicit bridge-level session cap (16) and idle TTL (5 minutes). Reject new initialization at capacity with a bounded service-unavailable response rather than silently evicting an in-flight session. Track per-session activity/in-flight requests; do not expire an active parked call. Closed sessions free their slots; idle sweeps are unref'd and stopped on bridge teardown. Add narrow optional test timing/cap overrides to the existing `StartMcpBridgeOptions`, rather than waiting five minutes in tests.

`stop()` must fail parks once, close every session's transport/server, clear sweep timers and registry, terminate HTTP connections, and remove its own config directory. Keep shutdown bounded as the existing code does. Do not include bearer header values in errors/logs.

**Verify:** focused command → additional tests prove cap rejection, slot reuse after session termination, idle expiry, and teardown with two initialized clients plus a pending park. Tests must use bounded deadlines and close all clients/handles in `finally`.

### Step 4: Verify old bridge capabilities across reconnect

Run the same catalog and dynamic-tool listing against A and B, and a park/result delivery after reconnect. Preserve long-call escalation/polling, tool counts, builtin names, skills activation, workspace history confinement, foreign Host rejection, body bounds, and bounded `stop()`.

**Verify:** focused tests, consumer tests, and full gate → all exit 0. Scope commands → no unrelated edits; update your index row.

## Test plan

Extend `tests/provider-mcp.test.ts` using its SDK client helper and isolated config directories. Add sequential/simultaneous clients, unknown session handling, cap/expiry/cleanup, and a bridged-tool park after reconnect. Never print the generated token or read real user session/config data. Unauthenticated malformed requests should remain rejected before initialization.

## Done criteria

- [ ] Two fresh clients initialize successfully against the same bridge URL.
- [ ] Distinct sessions have distinct transports and server instances.
- [ ] Catalog changes and parked tools work after reconnect.
- [ ] Session count, idle lifetime, and shutdown are deterministically bounded and tested.
- [ ] Existing security, skills, polling, and teardown tests still pass.
- [ ] Full gate and scope/whitespace checks pass.

## STOP conditions

Stop if the locked SDK lacks the needed session callbacks, handler sharing requires weakening auth, active parks cannot be distinguished from idle sessions, or implementation needs changes outside the listed files. Do not switch to an undocumented singleton-stateless transport workaround: the SDK rejects reusing that object across requests too. Stop after two failed reasonable attempts at any gate.

## Maintenance notes

A transport is a session, the HTTP server is the router, and bridge-owned state belongs to the workspace. Keep those lifetimes distinct. Future session caps/expiry must not orphan approval-gated parks, and dependency upgrades must rerun reconnect tests. The stale singleton comment must be replaced with an accurate ownership description.

