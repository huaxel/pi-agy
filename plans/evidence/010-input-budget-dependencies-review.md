# 010 input-budget and dependency remediation — execution review

> **Historical isolated-review phase.** After this review, the user separately authorized application to the original checkout. That application is complete and verified; see the [original-checkout integration receipt](010-original-checkout-integration.md). Statements below about an unchanged original checkout describe this earlier phase, not the current working tree.

## Verdict

**APPROVE — implemented and verified in an isolated worktree.** The user explicitly selected **Full plan 010 implementation**, including the 10,000-element/64-container-level input policy. No commit, staging, merge, push, publication, upstream contribution or live agy/provider inference occurred. No nested Pi process was launched.

Original checkout remains unchanged apart from planning/evidence artifacts. The reviewed implementation is retained at `/tmp/pi-agy-010-_jvae0qg/worktree` (canonical `/private/tmp/pi-agy-010-_jvae0qg/worktree`). Nothing is integrated into main.

## Provenance and delivery

- Base: `1bf9d29eaf0b56363ae7f62893670efe3eebeee3`, then approved patches **002,003,004,009,005,006**, in that order.
- The new executor reproduced the accepted 006 source byte-for-byte. Baseline accounting includes 71 tracked files plus the untracked prerequisite `tests/timing-helpers.ts` from 009. The scope check initially omitted that prerequisite from its manifest; it was accounted for by comparison/copy from the unchanged accepted 006 tree, not by treating it as new remediation work.
- Existing 330-test evidence was reused for the identical baseline. New 341-test evidence below qualifies the changed dependency graph and source; it does not merely repeat the old baseline result.
- Incremental artifact: [`010-input-budget-dependencies.patch`](../patches/010-input-budget-dependencies.patch).
- Patch SHA-256: `201930226f2a3ccc546d03db8641ea02c0c0e914c26a9c26187067a53df91041`.
- Patch applies cleanly to the accepted 006 stack (`git apply --check`, no application to that retained tree). Application order from base is **002,003,004,009,005,006,010**.
- Structured evidence: `plans/execution/010/implementation.json`. Raw logs, local tarball, private consumer and baseline copies are in the task worktree's ignored `.pi/`.

## Changed paths

Exactly seven incremental paths; all other prerequisite bytes are preserved:

1. `extensions/lib/bridge-input-budget.ts` — new pure iterative guard and fixed policy constants.
2. `extensions/lib/provider-mcp.ts` — guard after auth/Host/byte/parsing checks, before session resolution and SDK validation.
3. `tests/bridge-input-budget.test.ts` — exact boundaries, mixed structures, own/prototype-like keys and independent generated oracle.
4. `tests/provider-mcp.test.ts` — benign wire regressions, delegation/session witnesses, large strings, access-control order and recovery.
5. `package.json` — SDK floor only; no scripts, engine, peers or package-version change.
6. `package-lock.json` — targeted SDK closure and npm's stale root-version metadata normalization.
7. `README.md` — input contract, defensive scope and external-consumer resolution caveat.

## Behavior and causal evidence

The guard counts the **whole parsed request body's** object properties plus array slots, including metadata; it allows at most 10,000. Containers have depth at most 64, with the root container at 1; scalar content does not add container depth. Strings are still bounded by the existing 1 MiB UTF-8 reader.

Traversal is iterative. Wide arrays are checked before reading/queuing children; objects stop as soon as the aggregate property count exceeds the bound. Every queued child is charged to an already-counted property/slot. No recursive production walk, flattened descendant list, SDK-global setting, high-level server migration or per-tool bypass was added.

Over-budget structure returns a fixed HTTP 413 JSON error **before `resolveTransport`**, so it neither allocates a session nor parks a tool. Route/method, constant-time token, localhost Host and byte checks retain their prior order. Under-budget invalid request semantics remain with the existing handler/SDK.

Specific constrained-collection amplification exploitability was **not** demonstrated. The low-level SDK CallTool arguments schema is a record of unknown values, not the high-level registered-tool constrained-array validator. The local bound is defense-in-depth, not a claim of reproduced exploit remediation or general DoS immunity.

### Test-first slice

The new complex-initialization wire regression used valid metadata containing a bounded benign collection, below the byte limit. Before the guard, it failed with **HTTP 200 versus expected 413**; it did not fail from a missing import, invalid auth or timing setup. After the guard, it passed, witnessed **zero SDK transport delegations**, and a fresh client still initialized with session cap 1.

Further coverage includes exact 10,000/10,001 cardinality, 64/65 levels, aggregate wrapper counts, empty containers, prototype-like/Unicode own keys, 480 deterministic small-tree oracle cases, a 540 KB UTF-8 string, blocked tool-handler counts,403-before-structure ordering, malformed JSON 400, DELETE and fresh-client recovery. Existing park cancellation/escalation/teardown regressions remain intact. The generated grid is one test, not 480 inflated project-test counts.

## Dependency qualification

| Package | Before | Qualified after | Reason |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.31.0 (`^1.31.0`) | 1.32.2 (`^1.32.2`) | Approved fixed1.x floor; no v2 migration |
| `zod` | 4.6.5 | 4.6.7 | Patched repository resolution |
| `body-parser` | 2.3.0 | 2.4.0 | Within Express 5.2.1's `^2.2.1` constraint |
| `qs` | 6.16.0 | 6.17.1 | Consequence of body-parser's updated compatible dependency constraint |

No Pi peer or toolchain package entry changed. npm corrected lockfile root metadata from 0.7.6 to the manifest's existing 0.7.9; this was not a release/version bump. No hand-edited integrity hashes, overrides, unused direct Zod dependency or published shrinkwrap was introduced.

`npm ci --ignore-scripts` succeeded. `npm ls @modelcontextprotocol/sdk zod body-parser --all` exited 0; all repository resolutions of those packages were recorded, not just a potentially misleading top-level copy. Typecheck passed immediately after the dependency update and again after implementation.

## Verification actually run

All successful gate commands used Node 22.23.4/npm 10.9.9 on this macOS host, with `env -i`, private HOME and task-private agent directories. No lifecycle scripts were enabled.

| Check | Actual result | Raw evidence under task `.pi/` |
|---|---|---|
| New wire test before guard | Exit1, intended200/413 mismatch | `red-initialization.log` |
| First causal slice after guard |1/1 pass | `green-initialization.log` |
| Fresh locked install | Exit0 | `locked-install.log` |
| Focused guard/MCP/provider/driver | **91/91**,0 failed/cancelled/skipped | `focused.log`, `.exit` |
| Correctly isolated full gate | **341/341**,54 suites,0 failed/cancelled/skipped | `full-test-isolated.log`, `.exit` |
| Final typecheck | Exit0 | `final-typecheck.log`, `.exit` |
| Package dry-run | Exit0;43 entries, new guard included | `pack-check.log`, `.exit` |
| Installed private tarball consumer | Exit0; blocked input413, zero handler calls, normal call succeeds | `consumer-smoke.log`, `.exit` |
| Production-only audit | Exit1;0 high,0 critical,4 moderate package entries | `prod-audit.json` |
| All-dependency audit | Exit1;2 high,6 moderate,0 critical package entries | `audit-all.json` |
| Diff/scope/staging and apply check | Pass; seven approved incremental files; empty staging | implementation metadata and retained patch |

### Failed full run: diagnosed, not silently retried

The first full run passed 340/341 and failed the existing provider bridge-argument test (`2 !== 3`). My invocation supplied one explicit `/tmp/.../.pi/agent` to all fixtures. `withFakeAgy` intentionally preserves an explicit agent directory under `os.tmpdir()`, so a prior test's `providerBridge:false` file leaked into later fixtures. The already-passing focused run had left that file behind.

A paired experiment on unchanged code reproduced the failure with that same shared directory and passed with a canonical private directory outside the helper's lexical `/tmp/` prefix, restoring its per-call automatic isolation. No test, assertion, helper, production timeout or permission logic was changed to obtain green. The final full run used that corrected invocation. See `shared-fixture-repro.log` and `isolated-fixture-repro.log`; the original failure is retained as `full-test.log`.

## Installed-consumer check

A task-private consumer installed the local tarball with lifecycle scripts disabled, pinned the known Pi peers, and deliberately had root SDK 1.31.0/Zod 4.6.5. Inspection **from the installed bridge's own location** found:

- Its SDK floor forced a nested **SDK 1.32.2** under the installed pi-agy package.
- That SDK still resolved the host's **Zod 4.6.5**, accepted by its `^3.25 || ^4.0` range.
- Loading the actual shipped TypeScript through the consumer's Pi-supported jiti loader, an oversized benign tool request returned 413 before the synthetic tool handler ran. tools/list and an ordinary synthetic call then succeeded.

This is evidence for the shipped guard and the consumer-resolution caveat, **not** evidence that the entire consumer graph is patched. A repository lock or dependency-owned override cannot honestly promise that. The local tarball was not published; `.pi/` fixtures are not included in the package.

## Remaining advisories and limits

Production-only audit entries are now `@hono/node-server`, Hono, fast-uri and ip-address (four moderate package entries; individual advisories may have lower severities). Source/API distinctions remain important:

- Hono's Node request adapter is used by the SDK transport. Its flagged `serveStatic` API and the framework's corresponding static-file middleware are not configured by this bridge.
- fast-uri is under Ajv; the low-level SDK constructs a default Ajv provider, with the examined validator use in form elicitation. This bridge registers ListTools/CallTool handlers, not form elicitation. Arbitrary vulnerable URI-operation reachability is not established here; the package remains unpatched by this scoped change.
- ip-address is under `express-rate-limit`; the bridge does not configure that middleware and uses its own Node HTTP/auth path. Its affected long-address operation is not established on this bridge's request path. This is not a package-wide safety claim.

The all-dependency audit still reports **two high entries**, `brace-expansion` and `undici`, nested under the repository's development-pinned `@earendil-works/pi-coding-agent`. Those Pi packages are also host peers: omission from `--omit=dev` does **not** prove they cannot be runtime dependencies in another consumer. They were not upgraded or declared safe; broader host/peer remediation is outside 010.

Linux, Windows, minimum-Node, arbitrary Pi peer versions, live agy/provider turns and actual heap-exhaustion behavior were not tested. No universal consumer dependency guarantee is made. Committing, publishing and integrating into the original checkout were not attempted.

## Independent review

A native **Codex read-only** reviewer inspected the seven-file incremental change against immutable accepted-source copies. Its configured-model run completed with **APPROVE** and no actionable findings; it did not change files or rerun the gate. No worker remains pending.

The first attempt's explicitly selected model was rejected with: `The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.` The retry used the configured default model, not another Pi process. Both attempt logs are retained; no account/config repair or global settings change was made.

Reviewer findings, quoted with paths relative to the task worktree:

> **APPROVE.** No actionable bugs or important verification gaps found in the seven-file incremental diff. The iterative own-key/worklist budget is bounded for parsed JSON; the guard runs before session resolution/SDK validation/parking while preserving auth/Host/byte checks. Tests use an independent recursive oracle and cover aggregate counting, depth, metadata, large strings, refusal and recovery. Dependency changes are narrow and README correctly distinguishes repository lock qualification from consumer resolutions. No removal or weakening of prior fixes is visible.
>
> Unperformed by reviewer: test/typecheck reruns, upstream implementation audit, constrained-collection exploit proof and production/model inference. Baseline/focused/typecheck results were reported by the executor, not independently executed by the reviewer.

## Handoff

`python3 plans/execution/010/validate-implementation.py` passed **27 artifact/scope/receipt checks**. In addition to verifying the recorded gate exits and source hashes, it applied the incremental patch to a separate plain baseline copy and confirmed all seven resulting files exactly match the tested source. It did not rerun the software gate. The round-trip copy and structured result are retained in the implementation validation metadata.

[Read the isolated worktree README/input contract](http://dawn.localhost:9898/d/AugFRz-cdh_Fo92_).

The verified patch and worktree are retained for operator review. No additional implementation is pending in010. The unrelated advisories and platform/consumer qualifications above remain explicit; no integration or release is implied by this approval.
